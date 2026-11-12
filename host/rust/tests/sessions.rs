//! P9.7 (D327): session arrays pooled per Program, a bound on live sessions per
//! process. One test function: the limits and counts are process-wide.
use snug::schema::{Session, Step};
use snug::sessions::{self, SessionLimits};
use snug::{BytesBlob, CompileOptions, Error, Schema, Sequence, SequenceOptions, SourceOptions, ValidationOptions};

/// Driver options reading `chunk` bytes at a time.
fn c(chunk: usize) -> SourceOptions {
    SourceOptions { chunk, ..SourceOptions::default() }
}

/// Poll a future to completion (the drivers here never wait on I/O).
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn msg(i: u32) -> Vec<u8> {
    // {"body": "hello", "id": i}  (i < 24)
    let mut v = vec![0xa2, 0x64, b'b', b'o', b'd', b'y', 0x65, b'h', b'e', b'l', b'l', b'o', 0x62, b'i', b'd'];
    v.push((i % 24) as u8);
    v
}

#[test]
fn the_live_bound_release_on_finish_and_drop_and_threads() {
    let schema = Schema::compile("r = { id: uint, body: tstr }", &CompileOptions::default()).unwrap();
    let opts = ValidationOptions::default();
    let hp = snug::schema::Program::new(schema.program().words(), schema.program().pool()).unwrap();
    let host = &hp;
    let rule = host.rule("r").unwrap();
    let hopts = snug::schema::Options::default();
    let defaults = sessions::limits();
    assert_eq!(defaults, SessionLimits { max_live: 1024, max_pooled_bytes: 2 << 20 });
    assert!(sessions::set_limits(SessionLimits { max_live: 0, ..defaults }).is_err());
    assert_eq!(sessions::counts().live, 0);

    // the bound: one more than max_live fails with sessions/limit; a drop frees a slot
    sessions::set_limits(SessionLimits { max_live: 3, ..defaults }).unwrap();
    let b = msg(7);
    let held: Vec<Session<'_>> = (0..3).map(|_| Session::new(host, rule, b.len() as i32, &hopts, 0).unwrap()).collect();
    assert_eq!(sessions::counts().live, 3);
    let e = Session::new(host, rule, b.len() as i32, &hopts, 0).err().unwrap();
    assert_eq!(e, sessions::SessionError::Limit);
    assert_eq!(e.code(), "sessions/limit");
    assert_eq!(Error::from(e), Error::SessionLimit);
    assert_eq!(Error::from(e).code(), "sessions/limit");
    assert_eq!(schema.validate_blob(&BytesBlob(&b), "r", &opts, &c(4)).unwrap_err().code(), "sessions/limit");
    assert_eq!(Sequence::new(&SequenceOptions::default()).err().unwrap().code(), "sessions/limit");
    // every driver reports the bound as sessions/limit (sync and async, P9.6), never a panic or a read error
    assert_eq!(schema.validate_reader(&mut &b[..], "r", &opts, &c(4)).unwrap_err(), Error::SessionLimit);
    assert_eq!(snug::read_sequence(&b[..], &SequenceOptions::default()).err().unwrap(), Error::SessionLimit);
    assert_eq!(schema.read_sequence(&b[..], "r", &SequenceOptions::default()).err().unwrap(), Error::SessionLimit);
    assert_eq!(block_on(schema.validate_blob_async(&BytesBlob(&b), "r", &opts, &c(4))).unwrap_err(), Error::SessionLimit);
    assert_eq!(block_on(schema.validate_reader_async(&mut &b[..], "r", &opts, &c(4))).unwrap_err(), Error::SessionLimit);
    assert_eq!(snug::read_sequence_async(&b[..], &SequenceOptions::default()).err().unwrap(), Error::SessionLimit);
    assert_eq!(schema.read_sequence_async(&b[..], "r", &SequenceOptions::default()).err().unwrap(), Error::SessionLimit);
    drop(held);
    assert_eq!(block_on(schema.validate_blob_async(&BytesBlob(&b), "r", &opts, &c(4))).unwrap(), Ok(()));
    assert_eq!(sessions::counts().live, 0);

    // a finished session releases at its verdict, before it is dropped
    let mut s = Session::new(host, rule, b.len() as i32, &hopts, 0).unwrap();
    assert!(matches!(s.step(&b, 0), Step::Done(Ok(()))));
    assert_eq!(sessions::counts().live, 0);
    assert!(matches!(s.step(&b, 0), Step::Done(Ok(()))));
    drop(s);
    assert_eq!(sessions::counts().live, 0);
    sessions::set_limits(defaults).unwrap();

    // 100,000 sessions that finish never come near the bound
    for i in 0..100_000u32 {
        let b = msg(i);
        assert_eq!(schema.validate_blob(&BytesBlob(&b), "r", &opts, &c(3)).unwrap(), Ok(()));
    }
    assert_eq!(sessions::counts().live, 0);
    assert!(sessions::counts().pooled_bytes > 0);

    // pooled arrays scribbled on release (a reuse that skipped the zero-fill would show)
    // give the results of fresh arrays (no pool)
    let inputs: Vec<Vec<u8>> = vec![msg(1), vec![0xa1, 0x62, b'i', b'd', 0x01], vec![0xa2, 0x62, b'i', b'd', 0x01, 0x62, b'i', b'd', 0x02],
                                    vec![0xbf, 0x62, b'i', b'd', 0x01, 0x64, b'b', b'o', b'd', b'y', 0x60, 0xff], vec![0xa2, 0x62]];
    let run = || -> Vec<String> {
        inputs.iter().flat_map(|b| [1usize, 3, 4096].map(|n| format!("{:?}", schema.validate_blob(&BytesBlob(b), "r", &opts, &c(n))))).collect()
    };
    sessions::scribble_for_tests(true);
    let pooled = (run(), run());
    sessions::scribble_for_tests(false);
    sessions::set_limits(SessionLimits { max_pooled_bytes: 0, ..defaults }).unwrap();
    let fresh = run();
    sessions::set_limits(defaults).unwrap();
    assert_eq!(pooled.0, fresh);
    assert_eq!(pooled.1, fresh);

    // threads share the Program, its pool and the counters
    let schema = std::sync::Arc::new(schema);
    let handles: Vec<_> = (0..8).map(|t| {
        let schema = schema.clone();
        std::thread::spawn(move || {
            let opts = ValidationOptions::default();
            for i in 0..2_000u32 {
                let b = msg(i + t);
                assert_eq!(schema.validate_blob(&BytesBlob(&b), "r", &opts, &c(1 + (i as usize % 5))).unwrap(), Ok(()));
                let bad = vec![0xa1, 0x62, b'i', b'd', 0x01];
                assert!(schema.validate_blob(&BytesBlob(&bad), "r", &opts, &c(2)).unwrap().is_err());
            }
        })
    }).collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(sessions::counts().live, 0);

    // release_pool drops every idle entry; later sessions behave the same
    let run2 = || -> Vec<String> {
        inputs.iter().flat_map(|b| [1usize, 3, 4096].map(|n| format!("{:?}", schema.validate_blob(&BytesBlob(b), "r", &opts, &c(n))))).collect()
    };
    assert!(sessions::counts().pooled_bytes > 0);
    sessions::release_pool();
    assert_eq!(sessions::counts().pooled_bytes, 0);
    assert_eq!(run2(), fresh);
    assert!(sessions::counts().pooled_bytes > 0);
    // a dropped Program's idle entries are uncounted with it
    {
        let other = Schema::compile("r = [* uint]", &CompileOptions::default()).unwrap();
        let before = sessions::counts().pooled_bytes;
        assert_eq!(other.validate_blob(&BytesBlob(&[0x82, 1, 2]), "r", &opts, &c(1)).unwrap(), Ok(()));
        assert!(sessions::counts().pooled_bytes > before);
        drop(other);
        assert_eq!(sessions::counts().pooled_bytes, before);
    }

    // a sequence reader counts once and releases on drop
    let mut seq = Sequence::new(&SequenceOptions::default()).unwrap();
    assert_eq!(sessions::counts().live, 1);
    let two = [msg(1), msg(2)].concat();
    assert_eq!(seq.feed(&two).len(), 2);
    drop(seq);
    assert_eq!(sessions::counts().live, 0);
}

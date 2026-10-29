// `bb check`'s Rust arm: run snug.hello's probe on the fixed input and print
// the answers on one line, as the JS arm does.
fn main() {
    let input: [u8; 8] = [0x80, 0xff, 0x12, 0x34, 0x20, 0x41, 0x00, 0x42];
    let mut out = [0i32; 64];
    let n = snug::snug::hello::selftest(&mut out, &input) as usize;
    let parts: Vec<String> = out[..n].iter().map(|v| v.to_string()).collect();
    println!("{}", parts.join(" "));
}

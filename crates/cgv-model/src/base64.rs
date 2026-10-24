//! Standard base64 with padding, for binary data inside project files.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                text.push(ALPHABET[(n >> shift & 63) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}

fn value(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

/// The number of bytes `text` decodes to, without decoding it; None when it is
/// not padded base64.
pub fn decoded_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|&&c| c == b'=').count();
    if padding > 2 {
        return None;
    }
    Some(bytes.len() / 4 * 3 - padding)
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    let len = decoded_len(text)?;
    let mut bytes = Vec::with_capacity(len + 2);
    let input = text.as_bytes();
    for (index, chunk) in input.chunks(4).enumerate() {
        let last = index + 1 == input.len() / 4;
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = match c {
                b'=' if last && i >= 2 => 0,
                _ => value(c)?,
            };
            n = n << 6 | v;
        }
        bytes.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
    }
    bytes.truncate(len);
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_length() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
        let bytes: Vec<u8> = (0..=255).collect();
        for len in 0..bytes.len() {
            let text = encode(&bytes[..len]);
            assert_eq!(decoded_len(&text), Some(len));
            assert_eq!(decode(&text).as_deref(), Some(&bytes[..len]));
        }
        assert_eq!(decode("Zm9"), None);
        assert_eq!(decode("Zm9*"), None);
        assert_eq!(decode("Z=9v"), None);
    }
}

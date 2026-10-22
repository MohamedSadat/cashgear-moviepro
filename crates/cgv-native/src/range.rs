//! HTTP byte ranges for the `cgv-media://` protocol. The webview reads media
//! with `Range: bytes=N-`; answers are capped so no request loads a whole
//! multi-gigabyte file into memory. Mediabunny re-requests the rest.

/// An inclusive byte span of a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteSpan {
    pub start: u64,
    pub end: u64,
}

impl ByteSpan {
    pub fn len(self) -> u64 {
        self.end - self.start + 1
    }
    pub fn is_empty(self) -> bool {
        false
    }
    /// `bytes start-end/size`, for the Content-Range header.
    pub fn content_range(self, size: u64) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, size)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RangeError {
    /// Not a single `bytes=` range we understand.
    Malformed,
    /// Starts at or past the end of the file (HTTP 416).
    Unsatisfiable,
}

/// Resolves a `Range` header (or its absence, read as `bytes=0-`) against a file
/// of `size` bytes, returning at most `cap` bytes.
pub fn resolve(header: Option<&str>, size: u64, cap: u64) -> Result<ByteSpan, RangeError> {
    assert!(cap > 0, "cap must be positive");
    if size == 0 {
        return Err(RangeError::Unsatisfiable);
    }
    let spec = match header {
        None => "0-",
        Some(value) => value
            .trim()
            .strip_prefix("bytes=")
            .ok_or(RangeError::Malformed)?,
    };
    if spec.contains(',') {
        return Err(RangeError::Malformed);
    }
    let (first, last) = spec.split_once('-').ok_or(RangeError::Malformed)?;
    let parse = |text: &str| {
        text.trim()
            .parse::<u64>()
            .map_err(|_| RangeError::Malformed)
    };
    let (start, end) = if first.trim().is_empty() {
        // Suffix range: the last N bytes.
        let suffix = parse(last)?;
        if suffix == 0 {
            return Err(RangeError::Unsatisfiable);
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = parse(first)?;
        let end = if last.trim().is_empty() {
            size - 1
        } else {
            parse(last)?.min(size - 1)
        };
        (start, end)
    };
    if start >= size {
        return Err(RangeError::Unsatisfiable);
    }
    if end < start {
        return Err(RangeError::Malformed);
    }
    Ok(ByteSpan {
        start,
        end: end.min(start + cap - 1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn open_ended_ranges_are_capped() {
        let span = resolve(Some("bytes=0-"), 100 * MIB, 8 * MIB).unwrap();
        assert_eq!(
            span,
            ByteSpan {
                start: 0,
                end: 8 * MIB - 1
            }
        );
        assert_eq!(span.len(), 8 * MIB);
        assert_eq!(
            span.content_range(100 * MIB),
            format!("bytes 0-{}/{}", 8 * MIB - 1, 100 * MIB)
        );
        let tail = resolve(Some("bytes=99-"), 100, 8 * MIB).unwrap();
        assert_eq!(tail, ByteSpan { start: 99, end: 99 });
    }

    #[test]
    fn explicit_and_suffix_ranges() {
        assert_eq!(
            resolve(Some("bytes=10-19"), 100, MIB).unwrap(),
            ByteSpan { start: 10, end: 19 }
        );
        assert_eq!(
            resolve(Some("bytes=10-500"), 100, MIB).unwrap(),
            ByteSpan { start: 10, end: 99 }
        );
        assert_eq!(
            resolve(Some("bytes=-30"), 100, MIB).unwrap(),
            ByteSpan { start: 70, end: 99 }
        );
        assert_eq!(
            resolve(Some("bytes=-300"), 100, MIB).unwrap(),
            ByteSpan { start: 0, end: 99 }
        );
        assert_eq!(
            resolve(None, 100, 40).unwrap(),
            ByteSpan { start: 0, end: 39 }
        );
    }

    #[test]
    fn rejects_what_it_cannot_serve() {
        assert_eq!(
            resolve(Some("bytes=100-"), 100, MIB),
            Err(RangeError::Unsatisfiable)
        );
        assert_eq!(
            resolve(Some("bytes=-0"), 100, MIB),
            Err(RangeError::Unsatisfiable)
        );
        assert_eq!(
            resolve(Some("bytes=0-"), 0, MIB),
            Err(RangeError::Unsatisfiable)
        );
        assert_eq!(
            resolve(Some("items=0-1"), 100, MIB),
            Err(RangeError::Malformed)
        );
        assert_eq!(
            resolve(Some("bytes=0-1,5-6"), 100, MIB),
            Err(RangeError::Malformed)
        );
        assert_eq!(
            resolve(Some("bytes=9-3"), 100, MIB),
            Err(RangeError::Malformed)
        );
        assert_eq!(
            resolve(Some("bytes=a-"), 100, MIB),
            Err(RangeError::Malformed)
        );
    }
}

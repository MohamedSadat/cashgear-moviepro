use crate::{Flicks, FrameRate, FLICKS_PER_SECOND};

/// SMPTE timecode for a frame number: `HH:MM:SS:FF`, or `HH:MM:SS;FF` with
/// drop-frame counting (29.97 and 59.94 only; other rates ignore `drop_frame`).
pub fn timecode(frame: i64, rate: FrameRate, drop_frame: bool) -> String {
    let sign = if frame < 0 { "-" } else { "" };
    let mut frame = frame.unsigned_abs();
    let nominal = rate.nominal() as u64;
    let drop = drop_frame && rate.supports_drop_frame();
    if drop {
        // Skip frame labels 0 and 1 (2 and 3 too at 59.94) at the start of every
        // minute except each tenth minute, so the label tracks the clock.
        let dropped = nominal / 15;
        let per_ten_minutes = nominal * 600 - dropped * 9;
        let per_minute = nominal * 60 - dropped;
        let tens = frame / per_ten_minutes;
        let rest = frame % per_ten_minutes;
        frame += dropped * 9 * tens;
        if rest > dropped {
            frame += dropped * ((rest - dropped) / per_minute);
        }
    }
    let frames = frame % nominal;
    let seconds = frame / nominal;
    format!(
        "{sign}{:02}:{:02}:{:02}{}{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        if drop { ';' } else { ':' },
        frames
    )
}

/// A wall-clock duration: `M:SS.mmm` under an hour, `H:MM:SS.mmm` above.
pub fn format_clock(time: Flicks) -> String {
    let sign = if time.0 < 0 { "-" } else { "" };
    let millis_total = (time.0.unsigned_abs() as u128 * 1000 + FLICKS_PER_SECOND as u128 / 2)
        / FLICKS_PER_SECOND as u128;
    let millis = millis_total % 1000;
    let seconds = (millis_total / 1000) as u64;
    if seconds >= 3600 {
        format!(
            "{sign}{}:{:02}:{:02}.{millis:03}",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60
        )
    } else {
        format!("{sign}{}:{:02}.{millis:03}", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_drop_timecode() {
        assert_eq!(timecode(0, FrameRate::FPS_25, false), "00:00:00:00");
        assert_eq!(timecode(24, FrameRate::FPS_25, false), "00:00:00:24");
        assert_eq!(timecode(25, FrameRate::FPS_25, false), "00:00:01:00");
        assert_eq!(timecode(90_000, FrameRate::FPS_25, false), "01:00:00:00");
        assert_eq!(timecode(-30, FrameRate::FPS_30, false), "-00:00:01:00");
        // 23.976 counts in 24s and has no drop-frame form.
        assert_eq!(timecode(24, FrameRate::FPS_23_976, true), "00:00:01:00");
    }

    #[test]
    fn drop_frame_skips_labels_each_minute_except_tenths() {
        let rate = FrameRate::FPS_29_97;
        assert_eq!(timecode(1799, rate, true), "00:00:59;29");
        assert_eq!(timecode(1800, rate, true), "00:01:00;02");
        assert_eq!(timecode(17_981, rate, true), "00:09:59;29");
        assert_eq!(timecode(17_982, rate, true), "00:10:00;00");
        // One hour of 29.97 is 107,892 frames and reads exactly 01:00:00;00.
        assert_eq!(timecode(107_892, rate, true), "01:00:00;00");
        assert_eq!(timecode(1800, rate, false), "00:01:00:00");
    }

    #[test]
    fn drop_frame_at_59_94_drops_four() {
        let rate = FrameRate::FPS_59_94;
        assert_eq!(timecode(3599, rate, true), "00:00:59;59");
        assert_eq!(timecode(3600, rate, true), "00:01:00;04");
        assert_eq!(timecode(215_784, rate, true), "01:00:00;00");
    }

    #[test]
    fn clock_format() {
        assert_eq!(format_clock(Flicks::ZERO), "0:00.000");
        assert_eq!(format_clock(Flicks::from_seconds(10.0)), "0:10.000");
        assert_eq!(format_clock(Flicks::from_seconds(61.5)), "1:01.500");
        assert_eq!(format_clock(Flicks::from_seconds(3725.25)), "1:02:05.250");
        assert_eq!(format_clock(Flicks::from_seconds(-2.0)), "-0:02.000");
        assert_eq!(
            format_clock(FrameRate::FPS_29_97.time_of_frame(300)),
            "0:10.010"
        );
    }
}

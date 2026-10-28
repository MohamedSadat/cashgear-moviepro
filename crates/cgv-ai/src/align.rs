//! Word timing from Whisper's cross-attention, as OpenAI's `find_alignment`
//! does it: the alignment heads' attention over the encoder's frames is
//! standardised across tokens, median-filtered along time and averaged over
//! heads, and dynamic time warping finds the path through it. Each token's time
//! is where the path first reaches its row.

/// Encoder frames per second (each covers 20 ms).
pub const FRAMES_PER_SECOND: f64 = 50.0;
/// The median filter's width along time.
const MEDIAN_WIDTH: usize = 7;

/// When each token row starts, in seconds from the window's start. `weights`
/// holds `heads` blocks of `tokens` rows of `frames` attention weights (each
/// row softmaxed); row `k` is the position that predicts the `k`-th token.
pub fn token_times(weights: &[f32], heads: usize, tokens: usize, frames: usize) -> Vec<f64> {
    if heads == 0 || tokens == 0 || frames == 0 || weights.len() < heads * tokens * frames {
        return vec![0.0; tokens];
    }
    let mut matrix = vec![0.0f64; tokens * frames];
    let mut filtered = vec![0.0f64; frames];
    let mut window = Vec::with_capacity(MEDIAN_WIDTH);
    for head in 0..heads {
        let block = &weights[head * tokens * frames..(head + 1) * tokens * frames];
        // Standardise each frame across the tokens.
        let mut standard = vec![0.0f64; tokens * frames];
        for f in 0..frames {
            let mean = (0..tokens)
                .map(|t| block[t * frames + f] as f64)
                .sum::<f64>()
                / tokens as f64;
            let variance = (0..tokens)
                .map(|t| (block[t * frames + f] as f64 - mean).powi(2))
                .sum::<f64>()
                / tokens as f64;
            let deviation = variance.sqrt();
            for t in 0..tokens {
                let value = block[t * frames + f] as f64 - mean;
                standard[t * frames + f] = if deviation > 0.0 {
                    value / deviation
                } else {
                    0.0
                };
            }
        }
        // A median along time, with the edges reflected, then into the mean of heads.
        let pad = (MEDIAN_WIDTH / 2) as isize;
        for t in 0..tokens {
            let row = &standard[t * frames..(t + 1) * frames];
            let at = |i: isize| -> f64 {
                let n = frames as isize;
                let j = if n == 1 {
                    0
                } else if i < 0 {
                    (-i).min(n - 1)
                } else if i >= n {
                    (2 * (n - 1) - i).max(0)
                } else {
                    i
                };
                row[j as usize]
            };
            for (f, out) in filtered.iter_mut().enumerate() {
                window.clear();
                window.extend((-pad..=pad).map(|d| at(f as isize + d)));
                window.sort_by(f64::total_cmp);
                *out = window[window.len() / 2];
            }
            for (f, value) in filtered.iter().enumerate() {
                matrix[t * frames + f] += value / heads as f64;
            }
        }
    }
    let (rows, columns) = dtw(&matrix, tokens, frames);
    // Each row's time is where the path first steps into it.
    let mut times = vec![0.0; tokens];
    let mut previous = usize::MAX;
    for (&row, &column) in rows.iter().zip(&columns) {
        if row != previous {
            times[row] = column as f64 / FRAMES_PER_SECOND;
            previous = row;
        }
    }
    times
}

/// The cheapest path through `-matrix` from its first cell to its last, moving
/// down, right or both: the rows and columns it visits, in order.
fn dtw(matrix: &[f64], rows: usize, columns: usize) -> (Vec<usize>, Vec<usize>) {
    let width = columns + 1;
    let mut cost = vec![f64::INFINITY; (rows + 1) * width];
    let mut trace = vec![0u8; (rows + 1) * width];
    cost[0] = 0.0;
    for j in 1..=columns {
        for i in 1..=rows {
            let diagonal = cost[(i - 1) * width + j - 1];
            let up = cost[(i - 1) * width + j];
            let left = cost[i * width + j - 1];
            let (best, step) = if diagonal < up && diagonal < left {
                (diagonal, 0)
            } else if up < diagonal && up < left {
                (up, 1)
            } else {
                (left, 2)
            };
            cost[i * width + j] = -matrix[(i - 1) * columns + j - 1] + best;
            trace[i * width + j] = step;
        }
    }
    let (mut i, mut j) = (rows, columns);
    let mut path = Vec::with_capacity(rows + columns);
    while i > 0 || j > 0 {
        path.push((i - 1, j - 1));
        // The first row and column lead straight back to the start.
        let step = if i == 0 {
            2
        } else if j == 0 {
            1
        } else {
            trace[i * width + j]
        };
        match step {
            0 => {
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
        if i == 0 && j == 0 {
            break;
        }
    }
    path.reverse();
    path.into_iter()
        .filter(|&(i, j)| i < rows && j < columns)
        .unzip()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Attention of `heads` identical heads where token `k` looks at frames
    /// around `centres[k]`.
    fn attention(heads: usize, centres: &[usize], frames: usize) -> Vec<f32> {
        let mut weights = Vec::new();
        for _ in 0..heads {
            for &centre in centres {
                let row: Vec<f64> = (0..frames)
                    .map(|f| (-((f as f64 - centre as f64) / 3.0).powi(2)).exp() + 0.01)
                    .collect();
                let total: f64 = row.iter().sum();
                weights.extend(row.iter().map(|w| (w / total) as f32));
            }
        }
        weights
    }

    #[test]
    fn tokens_start_where_their_attention_does() {
        // Five tokens attending at 0.2 s, 0.6 s, 0.64 s, 1.3 s and 2 s.
        let centres = [10, 30, 32, 65, 100];
        let times = token_times(&attention(6, &centres, 150), 6, 5, 150);
        assert_eq!(times.len(), 5);
        assert!(times.windows(2).all(|pair| pair[0] <= pair[1]), "{times:?}");
        // The path steps into each row on its way to the next centre.
        for (time, centre) in times.iter().zip(centres) {
            assert!(
                *time <= centre as f64 / FRAMES_PER_SECOND + 0.02,
                "{times:?}"
            );
        }
        assert!(times[3] > 0.7 && times[4] > 1.4, "{times:?}");
    }

    #[test]
    fn the_path_covers_every_row_and_column_once_in_order() {
        let matrix: Vec<f64> = (0..12).map(|i| ((i * 7) % 5) as f64).collect();
        let (rows, columns) = dtw(&matrix, 3, 4);
        assert_eq!((rows[0], columns[0]), (0, 0));
        assert_eq!((*rows.last().unwrap(), *columns.last().unwrap()), (2, 3));
        for step in rows.windows(2).zip(columns.windows(2)) {
            let (dr, dc) = (step.0[1] - step.0[0], step.1[1] - step.1[0]);
            assert!(dr <= 1 && dc <= 1 && dr + dc >= 1);
        }
        assert_eq!(token_times(&[], 0, 2, 0), [0.0, 0.0]);
    }
}

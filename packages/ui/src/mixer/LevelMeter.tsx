import { useEffect, useRef } from 'react';
import type { MeterLevel, MeterReading } from '@cgv/engine-client';
import { MeterBallistics, meterFloor, meterPosition, meterTop } from './ballistics';
import type { MeterStore } from './useMeters';

const marks = [-48, -36, -24, -18, -12, -6, 0];

/**
 * A stereo level meter: peak bars that fall slowly, the RMS inside them, held
 * peak markers and a clip light. It draws itself from the meter store on
 * animation frames, outside React, while sound plays and until it has fallen.
 */
export function LevelMeter({
  meters,
  pick,
  label,
  testId,
}: {
  meters: MeterStore;
  /** The level this meter shows, from a reading. */
  pick(reading: MeterReading): MeterLevel | null;
  label: string;
  testId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef(pick);
  picker.current = pick;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const ballistics = new MeterBallistics();
    const bars = element.querySelectorAll<HTMLElement>('.cgv-meter-peak');
    const rms = element.querySelectorAll<HTMLElement>('.cgv-meter-rms');
    const holds = element.querySelectorAll<HTMLElement>('.cgv-meter-hold');
    const clip = element.querySelector<HTMLElement>('.cgv-meter-clip');
    let frame = 0;
    const draw = () => {
      frame = 0;
      const reading = meters.latest;
      const channels = ballistics.update(
        reading ? picker.current(reading) : null,
        performance.now(),
      );
      channels.forEach((channel, index) => {
        bars[index].style.clipPath = `inset(0 ${(1 - meterPosition(channel.peak)) * 100}% 0 0)`;
        rms[index].style.width = `${meterPosition(channel.rms) * 100}%`;
        holds[index].style.left = `${meterPosition(channel.hold) * 100}%`;
      });
      const [left, right] = channels;
      element.dataset.peakL = left.peak.toFixed(1);
      element.dataset.peakR = right.peak.toFixed(1);
      element.dataset.rmsL = left.rms.toFixed(1);
      element.dataset.rmsR = right.rms.toFixed(1);
      element.setAttribute('aria-valuenow', Math.max(left.peak, right.peak).toFixed(1));
      if (clip) clip.dataset.on = String(left.clipped || right.clipped);
      if (reading || !ballistics.resting) frame = requestAnimationFrame(draw);
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const unsubscribe = meters.subscribe(wake);
    wake();
    const reset = () => ballistics.resetClip();
    clip?.addEventListener('click', reset);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      clip?.removeEventListener('click', reset);
    };
  }, [meters]);

  return (
    <div
      ref={root}
      className="cgv-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={meterFloor}
      aria-valuemax={meterTop}
      aria-valuenow={meterFloor}
      data-testid={testId}
    >
      {[0, 1].map((channel) => (
        <div key={channel} className="cgv-meter-channel">
          <div className="cgv-meter-peak" />
          <div className="cgv-meter-rms" />
          <div className="cgv-meter-hold" />
        </div>
      ))}
      <div className="cgv-meter-scale" aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark} style={{ left: `${meterPosition(mark) * 100}%` }}>
            {mark}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="cgv-meter-clip"
        aria-label={`${label}: clipped. Click to reset.`}
        title="Reached 0 dBFS. Click to reset."
        data-on="false"
      />
    </div>
  );
}

/** The master's loudness in LUFS: momentary, short-term and since playback started. */
export function LoudnessReadout({ meters }: { meters: MeterStore }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const values = element.querySelectorAll<HTMLElement>('[data-value]');
    const show = () => {
      const reading = meters.latest;
      if (!reading) return;
      const numbers = [reading.momentary, reading.shortTerm, reading.integrated];
      numbers.forEach((value, index) => {
        values[index].textContent = value > -70 ? value.toFixed(1) : '–';
      });
      element.dataset.momentary = numbers[0].toFixed(2);
      element.dataset.shortTerm = numbers[1].toFixed(2);
      element.dataset.integrated = numbers[2].toFixed(2);
    };
    return meters.subscribe(show);
  }, [meters]);
  return (
    <div ref={root} className="cgv-loudness" data-testid="loudness-readout">
      {['Momentary', 'Short-term', 'Integrated'].map((name) => (
        <span key={name} className="cgv-loudness-value">
          <span className="cgv-muted">{name}</span>
          <span data-value>–</span>
        </span>
      ))}
      <span className="cgv-muted">LUFS</span>
    </div>
  );
}

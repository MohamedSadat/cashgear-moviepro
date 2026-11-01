"""Prints what OpenTimelineIO reads from a timeline file, as JSON the Rust test
compares with what it wrote: each track's items with their timeline and source
ranges and speeds, its dissolves, and the top level's markers. Test tool only."""
import json
import sys

import opentimelineio as otio


def frames(time, rate):
    return round(time.rescaled_to(rate).value, 3)


def remap_speed(effect):
    """The speed of an FCP7 Time Remap, which the adapter keeps as a plain effect."""
    settings = effect.metadata.get("fcp_xml", {})
    if settings.get("effectid") != "timeremap":
        return None
    values = {}
    for parameter in settings.get("parameter", []):
        values[parameter["parameterid"]] = parameter["value"]
    speed = float(values.get("speed", 100)) / 100
    return -speed if str(values.get("reverse")).upper() == "TRUE" else speed


def speed_of(item):
    speed = 1.0
    for effect in item.effects:
        if isinstance(effect, otio.schema.FreezeFrame):
            return 0.0
        if isinstance(effect, otio.schema.LinearTimeWarp):
            speed *= effect.time_scalar
            continue
        remapped = remap_speed(effect)
        if remapped is not None:
            speed *= remapped
    return round(speed, 2)


def main(path, rate):
    timeline = otio.adapters.read_from_file(path)
    if isinstance(timeline, otio.schema.SerializableCollection):
        timeline = next(iter(timeline))
    tracks = []
    # Video bottom first, then audio, as the file lists them.
    children = list(timeline.tracks)
    children.sort(key=lambda track: 0 if track.kind == "Video" else 1)
    for track in children:
        items = []
        dissolves = []
        for child in track:
            if isinstance(child, otio.schema.Transition):
                range_in_parent = track.range_of_child(track[track.index(child) + 1])
                cut = range_in_parent.start_time
                dissolves.append(
                    {
                        "cut": frames(cut, rate),
                        "before": frames(child.in_offset, rate),
                        "after": frames(child.out_offset, rate),
                    }
                )
            elif isinstance(child, otio.schema.Gap):
                continue
            else:
                span = track.range_of_child(child)
                source = child.trimmed_range()
                items.append(
                    {
                        "name": child.name,
                        "start": frames(span.start_time, rate),
                        "duration": frames(span.duration, rate),
                        "sourceStart": frames(source.start_time, rate),
                        "speed": speed_of(child),
                    }
                )
        if items:
            tracks.append(
                {"kind": str(track.kind), "items": items, "dissolves": dissolves}
            )
    markers = [
        {"name": marker.name, "time": frames(marker.marked_range.start_time, rate)}
        for marker in timeline.tracks.markers
    ]
    json.dump({"tracks": tracks, "markers": markers}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]))

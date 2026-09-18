import importlib.util
import queue
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock


foundry = types.ModuleType("foundry_local_sdk")
foundry.Configuration = object
foundry.FoundryLocalManager = object
sys.modules.setdefault("foundry_local_sdk", foundry)

spec = importlib.util.spec_from_file_location(
    "native_copilot_voice",
    Path(__file__).parents[1] / "python" / "native_copilot_voice.py",
)
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class Result:
    def __init__(self, text, is_final=True, segment_id=None, start_time=None, end_time=None):
        self.content = [types.SimpleNamespace(text=text)]
        self.is_final = is_final
        self.id = segment_id
        self.start_time = start_time
        self.end_time = end_time


class Session:
    def __init__(self, final_result=None):
        self.settings = types.SimpleNamespace()
        self.results = queue.Queue()
        self.stopped = False
        self.final_result = final_result

    def start(self):
        pass

    def append(self, _data):
        pass

    def get_stream(self):
        while True:
            result = self.results.get(timeout=1)
            if result is None:
                return
            yield result

    def stop(self):
        if self.stopped:
            return
        self.stopped = True
        if self.final_result:
            self.results.put(self.final_result)
        self.results.put(None)


class Stream:
    def start(self):
        pass

    def stop(self):
        pass

    def close(self):
        pass


class VoiceHelperTest(unittest.TestCase):
    def helper(self, final_result=None):
        helper = voice.VoiceHelper("model", "en")
        session = Session(final_result)
        helper.model = types.SimpleNamespace(
            get_audio_client=lambda: types.SimpleNamespace(
                create_live_transcription_session=lambda: session
            )
        )
        return helper, session

    def wait_for(self, events, event_type):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            matching = [event for event in events if event["type"] == event_type]
            if matching:
                return matching[-1]
            time.sleep(0.01)
        self.fail(f"Timed out waiting for {event_type}: {events}")

    def test_stop_flushes_final_transcript(self):
        helper, session = self.helper(Result("final transcript", segment_id="segment-1"))
        events = []
        sounddevice = types.SimpleNamespace(RawInputStream=lambda **_kwargs: Stream())
        with mock.patch.dict(sys.modules, {"sounddevice": sounddevice}), mock.patch.object(
            voice, "emit", events.append
        ):
            helper.start(30_000)
            session.results.put(Result("final", segment_id="segment-1"))
            self.wait_for(events, "partial")
            helper.stop()
            final = self.wait_for(events, "transcript")

        self.assertEqual(final["text"], "final transcript")
        self.assertFalse(any(event["type"] == "canceled" for event in events))
        self.assertTrue(helper.finished)

    def test_partial_segments_accumulate_without_duplicating_revisions(self):
        helper, session = self.helper(Result("test", segment_id="segment-3"))
        events = []
        sounddevice = types.SimpleNamespace(RawInputStream=lambda **_kwargs: Stream())
        with mock.patch.dict(sys.modules, {"sounddevice": sounddevice}), mock.patch.object(
            voice, "emit", events.append
        ):
            helper.start(30_000)
            session.results.put(Result("this is", segment_id="segment-1"))
            self.wait_for(events, "partial")
            session.results.put(Result("a", segment_id="segment-2"))
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                partials = [event for event in events if event["type"] == "partial"]
                if len(partials) == 2:
                    break
                time.sleep(0.01)
            session.results.put(Result("this was", segment_id="segment-1"))
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                partials = [event for event in events if event["type"] == "partial"]
                if len(partials) == 3:
                    break
                time.sleep(0.01)
            helper.stop()
            final = self.wait_for(events, "transcript")

        self.assertEqual([event["text"] for event in partials], [
            "this is",
            "this is a",
            "this was a",
        ])
        self.assertEqual(final["text"], "this was a test")

    def test_repeated_words_in_distinct_segments_are_preserved(self):
        helper, session = self.helper()
        events = []
        sounddevice = types.SimpleNamespace(RawInputStream=lambda **_kwargs: Stream())
        with mock.patch.dict(sys.modules, {"sounddevice": sounddevice}), mock.patch.object(
            voice, "emit", events.append
        ):
            helper.start(30_000)
            session.results.put(Result("very", segment_id="segment-1", start_time=0.0))
            self.wait_for(events, "partial")
            session.results.put(Result("very", segment_id="segment-2", start_time=0.5))
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                partials = [event for event in events if event["type"] == "partial"]
                if len(partials) == 2:
                    break
                time.sleep(0.01)
            helper.stop()
            final = self.wait_for(events, "transcript")

        self.assertEqual(partials[-1]["text"], "very very")
        self.assertEqual(final["text"], "very very")

    def test_cancel_discards_transcript(self):
        helper, _session = self.helper()
        events = []
        sounddevice = types.SimpleNamespace(RawInputStream=lambda **_kwargs: Stream())
        with mock.patch.dict(sys.modules, {"sounddevice": sounddevice}), mock.patch.object(
            voice, "emit", events.append
        ):
            helper.start(30_000)
            helper.finish("canceled")
            self.wait_for(events, "canceled")

        self.assertFalse(any(event["type"] == "transcript" for event in events))


if __name__ == "__main__":
    unittest.main()

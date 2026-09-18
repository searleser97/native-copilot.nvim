import argparse
import json
import queue
import sys
import threading

from foundry_local_sdk import Configuration, FoundryLocalManager


RATE = 16000
CHANNELS = 1
BLOCK_SIZE = RATE // 10


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class VoiceHelper:
    def __init__(self, model_alias, language):
        self.model_alias = model_alias
        self.language = language
        self.commands = queue.Queue()
        self.lock = threading.Lock()
        self.session = None
        self.stream = None
        self.timer = None
        self.finished = True

    def prepare(self):
        emit({"type": "state", "state": "loading"})
        config = Configuration(app_name="native-copilot.nvim")
        FoundryLocalManager.initialize(config)
        manager = FoundryLocalManager.instance
        manager.download_and_register_eps()
        self.model = manager.catalog.get_model(self.model_alias)
        if self.model is None:
            raise RuntimeError(f'Model "{self.model_alias}" was not found in the Foundry catalog.')
        self.model.download()
        self.model.load()
        emit({"type": "state", "state": "ready"})

    def start(self, timeout_ms):
        import sounddevice

        with self.lock:
            if not self.finished:
                raise RuntimeError("Voice dictation is already active.")
            self.finished = False
            audio_client = self.model.get_audio_client()
            self.session = audio_client.create_live_transcription_session()
            self.session.settings.sample_rate = RATE
            self.session.settings.channels = CHANNELS
            self.session.settings.language = self.language
            self.session.start()

            def capture(indata, _frames, _time_info, status):
                if status:
                    emit({"type": "state", "state": "audio_warning", "message": str(status)})
                with self.lock:
                    session = self.session if not self.finished else None
                if session is not None:
                    session.append(bytes(indata))

            self.stream = sounddevice.RawInputStream(
                samplerate=RATE,
                channels=CHANNELS,
                dtype="int16",
                blocksize=BLOCK_SIZE,
                callback=capture,
            )
            self.stream.start()
            self.timer = threading.Timer(timeout_ms / 1000, lambda: self.finish("no_speech"))
            self.timer.daemon = True
            self.timer.start()
            threading.Thread(target=self.read_results, daemon=True).start()
        emit({"type": "state", "state": "listening"})

    def read_results(self):
        try:
            for result in self.session.get_stream():
                text = result.content[0].text.strip() if result.content else ""
                if result.is_final and text:
                    threading.Thread(
                        target=lambda: self.finish("transcript", text), daemon=True
                    ).start()
                    return
                if text:
                    emit({"type": "partial", "text": text})
        except Exception as error:
            if self.finished:
                emit({"type": "error", "message": str(error)})
            else:
                self.finish("error", message=str(error))

    def finish(self, kind, text=None, message=None):
        with self.lock:
            if self.finished:
                return
            self.finished = True
            timer, stream, session = self.timer, self.stream, self.session
            self.timer = self.stream = self.session = None
        if timer:
            timer.cancel()
        if stream:
            stream.stop()
            stream.close()
        if session:
            session.stop()
        event = {"type": kind}
        if text is not None:
            event["text"] = text
        if message is not None:
            event["message"] = message
        emit(event)

    def run(self):
        threading.Thread(target=self.read_commands, daemon=True).start()
        self.prepare()
        while True:
            command = self.commands.get()
            name = command.get("command")
            try:
                if name == "start":
                    self.start(int(command.get("timeout_ms", 30000)))
                elif name == "cancel":
                    self.finish("canceled")
                elif name == "shutdown":
                    self.finish("canceled")
                    self.model.unload()
                    return
                else:
                    emit({"type": "error", "message": f"Unknown voice command: {name}"})
            except Exception as error:
                self.finish("error", message=str(error))

    def read_commands(self):
        for line in sys.stdin:
            try:
                self.commands.put(json.loads(line))
            except Exception as error:
                emit({"type": "error", "message": f"Invalid voice command: {error}"})
        self.commands.put({"command": "shutdown"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--model", default="nemotron-speech-streaming-en-0.6b")
    parser.add_argument("--language", default="en")
    args = parser.parse_args()
    helper = VoiceHelper(args.model, args.language)
    if args.prepare:
        helper.prepare()
        helper.model.unload()
        return
    helper.run()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        print(str(error), file=sys.stderr)
        raise

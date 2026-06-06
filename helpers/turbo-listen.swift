// Turbo's native ear. Continuous on-device speech recognition using Apple's
// Speech framework. Prints each finalised utterance to stdout as:
//     FINAL\t<transcript>
// and partials as PARTIAL\t<transcript>. Errors as ERR <reason>.
// Rust spawns this, reads stdout, and looks for the "hey turbo" wake word.

import AVFoundation
import Foundation
import Speech

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var restarting = false

// When launched via `open --args <path>`, mirror output to a log file the host
// app tails (stdout isn't captured for LaunchServices-launched apps).
let logPath: String? = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
let partialPath: String? = logPath.map { $0 + ".partial" }
let logHandle: FileHandle? = {
    guard let p = logPath else { return nil }
    FileManager.default.createFile(atPath: p, contents: nil)
    return FileHandle(forWritingAtPath: p)
}()

func emit(_ s: String) {
    print(s)
    fflush(stdout)
    // Partials overwrite a single file (they fire constantly); everything else
    // is appended to the event log.
    if s.hasPrefix("PARTIAL\t"), let p = partialPath {
        let text = String(s.dropFirst("PARTIAL\t".count))
        try? text.write(toFile: p, atomically: true, encoding: .utf8)
    } else if let h = logHandle, let d = (s + "\n").data(using: .utf8) {
        h.write(d)
    }
}

func startRecognition() {
    restarting = false
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 13, *) {
        req.requiresOnDeviceRecognition = true
    }
    request = req

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        req.append(buffer)
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit("ERR engine \(error.localizedDescription)")
        scheduleRestart()
        return
    }

    task = recognizer?.recognitionTask(with: req) { result, error in
        if let result = result {
            let text = result.bestTranscription.formattedString
            emit("PARTIAL\t\(text)")
            if result.isFinal {
                emit("FINAL\t\(text)")
                scheduleRestart()
            }
        }
        if error != nil {
            scheduleRestart()
        }
    }
}

func stopRecognition() {
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
}

// SFSpeech requests time out after ~1 min; restart to listen forever.
func scheduleRestart() {
    if restarting { return }
    restarting = true
    stopRecognition()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        startRecognition()
    }
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        emit("ERR speech-not-authorized")
        exit(1)
    }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        guard granted else {
            emit("ERR mic-not-authorized")
            exit(1)
        }
        DispatchQueue.main.async {
            emit("READY")
            startRecognition()
        }
    }
}

RunLoop.main.run()

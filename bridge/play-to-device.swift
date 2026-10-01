// Plays one audio file to one named output device, and nothing else:
//   play-to-device "BlackHole 2ch" /path/to/intro.wav
//
// Used only for Jarvis's spoken introduction in a Zoom call: BlackHole is the
// microphone of Jarvis's Zoom window, and this is the only thing that ever
// writes to it. If the named device is missing it exits with an error rather
// than falling back to any other output. Exit 0 once the file has finished.
//
// Built by the bridge on first use (swiftc, from the Xcode command line tools).
import AVFoundation
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments

/// The name of a device, or "" if it has none.
func deviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var cfName: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &cfName) == noErr,
        let n = cfName?.takeRetainedValue() as String? else { return "" }
  return n
}

/// `play-to-device --defaults`: the default output and system-sound devices, one per line.
if args.count == 2 && args[1] == "--defaults" {
  for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    print(deviceName(id))
  }
  exit(0)
}

guard args.count == 3 else { fail("usage: play-to-device <device name> <file> | --defaults") }
let wanted = args[1]
let path = args[2]

/// The output device whose name is exactly `name`, if there is one.
func outputDevice(named name: String) -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return nil }
  for id in ids {
    // Has output channels?
    var streams = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeOutput,
      mElement: kAudioObjectPropertyElementMain)
    var streamSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize)
    if streamSize == 0 { continue }
    var nameAddress = AudioObjectPropertyAddress(
      mSelector: kAudioObjectPropertyName,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var cfName: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &cfName) == noErr,
          let n = cfName?.takeRetainedValue() as String? else { continue }
    if n == name { return id }
  }
  return nil
}

guard let device = outputDevice(named: wanted) else { fail("no output device named \(wanted)") }
let file: AVAudioFile
do { file = try AVAudioFile(forReading: URL(fileURLWithPath: path)) } catch { fail("cannot read \(path): \(error)") }

let engine = AVAudioEngine()
var id = device
guard let unit = engine.outputNode.audioUnit,
      AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id,
                           UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
else { fail("cannot select \(wanted)") }

let player = AVAudioPlayerNode()
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
let done = DispatchSemaphore(value: 0)
player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in done.signal() }
do { try engine.start() } catch { fail("cannot start audio: \(error)") }
player.play()
done.wait()
engine.stop()
exit(0)

// Sets up OBS Studio for Jarvis's meeting camera:
//   node scripts/obs-setup.mjs
//
// Writes only the "Jarvis" profile and the "Jarvis" scene collection, plus
// first-run defaults in user.ini when there is no user.ini yet. Other OBS
// profiles and scene collections are never touched. Safe to run again.
//
// The scene is one browser source showing the meeting tile
// (http://localhost:5173/tile) at 1280x720. There are no audio sources at all:
// no desktop audio, no microphone, and the browser source's own audio is
// routed into OBS (where nothing plays or records it) rather than to the
// speakers. OBS's virtual camera on macOS carries video only.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TILE_URL = process.env.JARVIS_TILE_URL || 'http://localhost:5173/tile'
const OBS = join(homedir(), 'Library', 'Application Support', 'obs-studio')
const NAME = 'Jarvis'

const profileDir = join(OBS, 'basic', 'profiles', NAME)
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'basic.ini'),
  `[General]
Name=${NAME}

[Video]
BaseCX=1280
BaseCY=720
OutputCX=1280
OutputCY=720
FPSType=0
FPSCommon=30

[Audio]
SampleRate=48000
ChannelSetup=Stereo
`,
)

const tile = randomUUID()
const scene = randomUUID()
mkdirSync(join(OBS, 'basic', 'scenes'), { recursive: true })
writeFileSync(
  join(OBS, 'basic', 'scenes', `${NAME}.json`),
  JSON.stringify(
    {
      name: NAME,
      current_scene: NAME,
      current_program_scene: NAME,
      scene_order: [{ name: NAME }],
      sources: [
        {
          id: 'browser_source',
          versioned_id: 'browser_source',
          name: 'Jarvis tile',
          uuid: tile,
          settings: {
            url: TILE_URL,
            width: 1280,
            height: 720,
            fps_custom: false,
            reroute_audio: true,
            shutdown: false,
            restart_when_active: false,
            css: '',
          },
          enabled: true,
          muted: true,
          volume: 0,
          mixers: 0,
          flags: 0,
        },
        {
          id: 'scene',
          versioned_id: 'scene',
          name: NAME,
          uuid: scene,
          settings: {
            id_counter: 1,
            custom_size: false,
            items: [
              {
                name: 'Jarvis tile',
                source_uuid: tile,
                id: 1,
                visible: true,
                locked: true,
                pos: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rot: 0,
                align: 5,
                bounds_type: 0,
              },
            ],
          },
        },
      ],
      groups: [],
      transitions: [],
      current_transition: 'Fade',
      transition_duration: 300,
      quick_transitions: [],
      saved_projectors: [],
      modules: {},
    },
    null,
    2,
  ),
)

// First run only: skip the auto-configuration wizard and the permissions
// dialog (the virtual camera needs neither screen recording nor the mic),
// and open on the Jarvis profile and scene.
const userIni = join(OBS, 'user.ini')
if (!existsSync(userIni)) {
  writeFileSync(
    userIni,
    `[General]
FirstRun=true
MacOSPermissionsDialogLastShown=1

[Basic]
Profile=${NAME}
ProfileDir=${NAME}
SceneCollection=${NAME}
SceneCollectionFile=${NAME}
`,
  )
}

console.log(`OBS: profile and scene collection "${NAME}" written; tile ${TILE_URL}`)

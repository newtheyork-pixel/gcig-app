// Griffin Fund additions. This file is appended verbatim to Jitsi's
// generated config.js, so everything here overrides what came before it.

// ---------------------------------------------------------------------
// Bandwidth. Read this before changing any number below it.
//
// The bridge receives one video stream per sender and sends one copy per
// sender per viewer. Its upload therefore grows with the PRODUCT of
// senders and viewers, not with headcount. Measured upstream on the line
// this runs on is 33 Mbps, and that is the entire budget.
//
// Worked example at 39 members, which is the whole club:
//   everyone on camera, tile view   39 x 38 x 0.2 Mbps  = 296 Mbps   no
//   channelLastN 6                  39 x  6 x 0.2 Mbps  =  47 Mbps   no
//   channelLastN 4, one at 360p     39 x (0.6 + 3x0.15) =  41 Mbps   no
//   presenter only, lastN 1         39 x 0.6 + audio    =  29 Mbps   yes
//
// So the default below is tuned for the meeting shape we actually hold,
// which is a dozen or so people talking. A full all-hands must run in
// presentation mode, and the room API sets that by appending
// #config.channelLastN=1 to the link rather than by editing this file.
// ---------------------------------------------------------------------

// Most video streams the bridge will forward to any one viewer. Everyone
// still hears everyone; this caps only what is sent as picture.
config.channelLastN = 6;

// Only the active speaker gets a full-resolution stream. Everyone else is
// a thumbnail, which is roughly a quarter of the bitrate.
config.maxFullResolutionParticipants = 1;

// Past this many people in the room, new arrivals join with camera off.
// They can turn it on deliberately; it just stops a large meeting from
// saturating the line by accident.
config.startVideoMuted = 10;

config.resolution = 720;
config.constraints = {
    video: {
        height: { ideal: 540, max: 720, min: 180 },
        width: { ideal: 960, max: 1280, min: 320 }
    }
};

// Simulcast lets the bridge drop to a lower layer per viewer instead of
// dropping the stream. On a constrained uplink this is the difference
// between a soft picture and a frozen one.
config.disableSimulcast = false;
config.enableAdaptiveMode = true;

// Two people in a room talk directly to each other and never touch the
// bridge, which costs this line nothing at all. Worth keeping on.
config.p2p = { enabled: true };

// ---------------------------------------------------------------------
// Privacy. Nothing about a Griffin meeting should leave our own machines.
// ---------------------------------------------------------------------
config.disableThirdPartyRequests = true;
config.analytics = { disabled: true, rtcstatsEnabled: false };
config.deploymentInfo = { environment: 'griffin-prod' };
config.doNotStoreRoom = true;

// ---------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------
config.prejoinConfig = {
    enabled: true,
    hideDisplayName: false,
    hideExtraJoinButtons: [ 'no-audio', 'by-phone' ]
};

config.toolbarButtons = [
    'microphone', 'camera', 'desktop', 'chat', 'raisehand', 'reactions',
    'participants-pane', 'tileview', 'select-background', 'settings',
    'videoquality', 'fullscreen', 'toggle-camera', 'mute-everyone',
    'mute-video-everyone', 'security', 'shareaudio', 'whiteboard', 'hangup'
];

config.hideConferenceSubject = false;
config.hideConferenceTimer = false;
config.disableProfile = false;
config.requireDisplayName = true;
config.defaultLocalDisplayName = 'Me';
config.defaultRemoteDisplayName = 'Griffin member';
config.disableReactions = false;
config.disablePolls = false;
config.enableNoisyMicDetection = true;
config.enableTalkWhileMuted = true;

// Opus at 24 kbps is transparent for speech and costs a fifth of what the
// music-grade default does. With 39 people in a room, audio alone would
// otherwise be a meaningful slice of the uplink.
config.audioQuality = { opusMaxAverageBitrate: 24000, enableOpusRed: true };
config.stereo = false;
config.enableOpusRed = true;

// Recording is deliberately absent. Jibri needs its own container and
// more upload than this line has, and a recorded meeting is a consent
// question before it is a technical one. Local recording stays available
// and tells the room it has started.
config.localRecording = { disable: false, notifyAllParticipants: true };

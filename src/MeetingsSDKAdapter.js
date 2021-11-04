import {MeetingsAdapter, MeetingState} from '@webex/component-adapter-interfaces';
import {deconstructHydraId} from '@webex/common';
import {
  concat,
  from,
  fromEvent,
  merge,
  Observable,
  of,
} from 'rxjs';
import {
  catchError,
  concatMap,
  filter,
  map,
  publishReplay,
  refCount,
  takeWhile,
  tap,
} from 'rxjs/operators';

import logger from './logger';
import AudioControl from './MeetingsSDKAdapter/controls/AudioControl';
import ExitControl from './MeetingsSDKAdapter/controls/ExitControl';
import JoinControl from './MeetingsSDKAdapter/controls/JoinControl';
import RosterControl from './MeetingsSDKAdapter/controls/RosterControl';
import SettingsControl from './MeetingsSDKAdapter/controls/SettingsControl';
import ShareControl from './MeetingsSDKAdapter/controls/ShareControl';
import SwitchCameraControl from './MeetingsSDKAdapter/controls/SwitchCameraControl';
import SwitchMicrophoneControl from './MeetingsSDKAdapter/controls/SwitchMicrophoneControl';
import SwitchSpeakerControl from './MeetingsSDKAdapter/controls/SwitchSpeakerControl';
import VideoControl from './MeetingsSDKAdapter/controls/VideoControl';
import {chainWith, deepMerge} from './utils';

// TODO: Figure out how to import JS Doc definitions and remove duplication.
/**
 * A video conference in Webex over WebRTC.
 *
 * @external Meeting
 * @see {@link https://github.com/webex/component-adapter-interfaces/blob/master/src/MeetingsAdapter.js#L20}
 * @see {@link https://webrtc.org}
 */

// TODO: Figure out how to import JS Doc definitions and remove duplication.
/**
 * Display options of a meeting control.
 *
 * @external MeetingControlDisplay
 * @see {@link https://github.com/webex/component-adapter-interfaces/blob/master/src/MeetingsAdapter.js#L58}
 */

// JS SDK Events
const EVENT_MEDIA_READY = 'media:ready';
const EVENT_MEDIA_STOPPED = 'media:stopped';
const EVENT_STATE_CHANGE = 'meeting:stateChange';
const EVENT_LOCAL_SHARE_STOP = 'meeting:stoppedSharingLocal';
const EVENT_LOCAL_SHARE_START = 'meeting:startedSharingLocal';
const EVENT_REMOTE_SHARE_START = 'meeting:startedSharingRemote';
const EVENT_REMOTE_SHARE_STOP = 'meeting:stoppedSharingRemote';

// Adapter Events
const EVENT_MEETING_UPDATED = 'adapter:meeting:updated';
const EVENT_CAMERA_SWITCH = 'adapter:camera:switch';
const EVENT_MICROPHONE_SWITCH = 'adapter:microphone:switch';

// Meeting controls
const JOIN_CONTROL = 'join-meeting';
const EXIT_CONTROL = 'leave-meeting';
const AUDIO_CONTROL = 'mute-audio';
const VIDEO_CONTROL = 'mute-video';
const SHARE_CONTROL = 'share-screen';
const ROSTER_CONTROL = 'member-roster';
const SETTINGS_CONTROL = 'settings';
const SWITCH_CAMERA_CONTROL = 'switch-camera';
const SWITCH_MICROPHONE_CONTROL = 'switch-microphone';
const SWITCH_SPEAKER_CONTROL = 'switch-speaker';

// Media stream types
const MEDIA_TYPE_LOCAL = 'local';
const MEDIA_TYPE_LOCAL_SHARE = 'localShare';
const MEDIA_TYPE_REMOTE_AUDIO = 'remoteAudio';
const MEDIA_TYPE_REMOTE_VIDEO = 'remoteVideo';
const MEDIA_TYPE_REMOTE_SHARE = 'remoteShare';
const MEDIA_EVENT_TYPES = [
  MEDIA_TYPE_LOCAL,
  MEDIA_TYPE_LOCAL_SHARE,
  MEDIA_TYPE_REMOTE_AUDIO,
  MEDIA_TYPE_REMOTE_VIDEO,
  MEDIA_TYPE_REMOTE_SHARE,
];

const mediaSettings = {
  receiveVideo: true,
  receiveAudio: true,
  receiveShare: true,
  sendVideo: true,
  sendAudio: true,
  sendShare: false,
};

const HYDRA_ID_TYPE_PEOPLE = 'PEOPLE';
const HYDRA_ID_TYPE_ROOM = 'ROOM';

/**
 * The `MeetingsSDKAdapter` is an implementation of the `MeetingsAdapter` interface.
 * This adapter utilizes the Webex JS SDK to create and join Webex meetings.
 *
 * @implements {MeetingsAdapter}
 */
export default class MeetingsSDKAdapter extends MeetingsAdapter {
  constructor(datasource) {
    super(datasource);
    this.getMeetingObservables = {};
    this.meetings = {};

    this.meetingControls = {
      [JOIN_CONTROL]: new JoinControl(this, JOIN_CONTROL),
      [AUDIO_CONTROL]: new AudioControl(this, AUDIO_CONTROL),
      [VIDEO_CONTROL]: new VideoControl(this, VIDEO_CONTROL),
      [SHARE_CONTROL]: new ShareControl(this, SHARE_CONTROL),
      [EXIT_CONTROL]: new ExitControl(this, EXIT_CONTROL),
      [ROSTER_CONTROL]: new RosterControl(this, ROSTER_CONTROL),
      [SETTINGS_CONTROL]: new SettingsControl(this, SETTINGS_CONTROL),
      [SWITCH_CAMERA_CONTROL]: new SwitchCameraControl(this, SWITCH_CAMERA_CONTROL),
      [SWITCH_SPEAKER_CONTROL]: new SwitchSpeakerControl(this, SWITCH_SPEAKER_CONTROL),
      [SWITCH_MICROPHONE_CONTROL]: new SwitchMicrophoneControl(this, SWITCH_MICROPHONE_CONTROL),
    };
  }

  /**
   * Register the SDK meeting plugin to the device
   * and sync the meeting collection from the server.
   */
  async connect() {
    await this.datasource.meetings.register();
    await this.datasource.meetings.syncMeetings();
  }

  /**
   * Unregister the SDK meeting plugin from the device.
   */
  async disconnect() {
    await this.datasource.meetings.unregister();
  }

  /**
   * Returns an observable that emits local device media streams and their user permission status
   *
   * @private
   * @param {string} ID ID to retrieve the SDK meeting object to add the local media to
   * @returns {Observable} Observable that emits local media streams and their user permission status
   */
  getLocalMedia(ID) {
    logger.debug('MEETING', ID, 'getLocalMedia()', ['called with', {ID}]);
    const {sendAudio, sendVideo} = mediaSettings;

    return this.getStreamWithPermission(sendAudio, ID, {sendAudio: true}).pipe(
      map(({permission, stream, ignore}) => ({
        localAudio: {
          stream,
          permission,
          ignoreMediaAccessPrompt: ignore,
        },
        localVideo: {
          stream: null,
          permission: null,
        },
      })),
      chainWith((audio) => this.getStreamWithPermission(sendVideo, ID, {sendVideo: true}).pipe(
        map(({permission, stream, ignore}) => ({
          ...audio,
          localVideo: {
            stream,
            permission,
            ignoreMediaAccessPrompt: ignore,
          },
        })),
      )),
    );
  }

  /**
   * Returns an observable that emits local device media streams and their user permission status based on the given constraints.
   *
   * @see {@link MediaStream|https://developer.mozilla.org/en-US/docs/Web/API/MediaStream}.
   *
   * @private
   * @param {string} ID ID of the meeting for which to fetch streams
   * @param {object} mediaDirection A configurable options object for joining a meetings
   * @param {object} audioVideo audio/video object to set audioinput and videoinput devices
   * @returns {Observable} Observable that emits local media streams and their user permission status
   */
  getStream(ID, mediaDirection, audioVideo) {
    logger.debug('MEETING', ID, 'getStream()', ['called with', {ID, mediaDirection, audioVideo}]);

    return new Observable(async (subscriber) => {
      let ignored = false;
      let isAsking;

      try {
        const sdkMeeting = this.fetchMeeting(ID);

        const ignore = () => {
          ignored = true;
          subscriber.next({permission: 'IGNORED', stream: null});
          subscriber.complete();
        };

        // wait a bit for the prompt to appear before emitting ASKING
        isAsking = true;
        setTimeout(() => {
          if (isAsking) {
            // media access promise was neither fulfilled nor rejected, so the browser prompt is probably showing
            subscriber.next({permission: 'ASKING', stream: null, ignore});
          }
        }, 2000);

        const [localStream] = await sdkMeeting.getMediaStreams(mediaDirection, audioVideo);

        isAsking = false;

        for (const track of localStream.getTracks()) {
          if (track.kind === 'video' && !mediaDirection.sendVideo) {
            localStream.removeTrack(track);
          }
          if (track.kind === 'audio' && !mediaDirection.sendAudio) {
            localStream.removeTrack(track);
          }
        }

        if (!ignored) {
          subscriber.next({permission: 'ALLOWED', stream: localStream});
          subscriber.complete();
        }
      } catch (error) {
        isAsking = false;

        if (!ignored) {
          let perm;

          // eslint-disable-next-line no-console
          console.error('Unable to retrieve local media stream for meeting', ID, 'with mediaDirection', mediaDirection, 'and audioVideo', audioVideo, 'reason:', error);

          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            if (error.message === 'Permission dismissed') {
              perm = 'DISMISSED';
            } else {
              perm = 'DENIED';
            }
          } else {
            perm = 'ERROR';
          }
          subscriber.next({permission: perm, stream: null});
          subscriber.complete();
        }
      }
    });
  }

  /**
   * Returns an observable that emits local device media streams and their user permission status
   *
   * @private
   * @param {boolean} condition Meeting mediaSettings propery condition for sending streams
   * @param {string} ID Meeting ID
   * @param {object} mediaDirection A configurable options object for joining a meetings
   * @param {object} audioVideo audio/video object to set audioinput and videoinput devices
   * @returns {Observable} Observable that emits local media streams and their user permission status
   */
  getStreamWithPermission(condition, ID, mediaDirection, audioVideo) {
    logger.debug('MEETING', ID, 'getStreamWithPermission()', ['called with these params', {
      condition, ID, mediaDirection, audioVideo,
    }]);

    return condition
      ? this.getStream(ID, mediaDirection, audioVideo)
      : of({permission: null, stream: null});
  }

  /**
   * Returns available media devices.
   *
   * @param {string} ID ID of the meeting
   * @param {'videoinput'|'audioinput'|'audiooutput'} type String specifying the device type.
   * See {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/kind|MDN}
   * @returns {MediaDeviceInfo[]} Array containing media devices.
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  async getAvailableDevices(ID, type) {
    logger.debug('MEETING', ID, 'getAvailableDevices()', ['called with', {ID, type}]);
    let devices;

    try {
      const sdkMeeting = this.fetchMeeting(ID);

      devices = await sdkMeeting.getDevices();
      devices = devices.filter((device) => device.kind === type && device.deviceId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Unable to retrieve devices for meeting "${ID}"`, error);

      devices = [];
    }

    logger.debug('MEETING', ID, 'getAvailabelDevices()', ['return', devices]);

    return devices;
  }

  /**
   * Update the meeting object with media attached based on a given event type.
   *
   * @private
   * @param {string} ID ID of the meeting to update
   * @param {object} media Media stream to attach to the meeting object based on a given event type
   * @param {string} media.type Type of event associated with the media change
   * @param {MediaStream} media.stream Media stream to attach to meeting
   */
  attachMedia(ID, {type, stream}) {
    logger.debug('MEETING', ID, 'attachMedia()', ['called with', {ID, type, stream}]);
    const meeting = {...this.meetings[ID]};

    switch (type) {
      case MEDIA_TYPE_LOCAL:
        this.meetings[ID] = {
          ...meeting,
          // Attach the media streams only if the streams are unmuted
          // `disableLocalAudio/Video` change inside handle media stream methods
          localAudio: {
            ...meeting.localAudio,
            stream: meeting.disabledLocalAudio ? null : new MediaStream(stream.getAudioTracks()),
          },
          localVideo: {
            ...meeting.localVideo,
            stream: meeting.disabledLocalVideo ? null : new MediaStream(stream.getVideoTracks()),
          },
        };
        break;
      case MEDIA_TYPE_REMOTE_AUDIO:
        this.meetings[ID] = {...meeting, remoteAudio: stream};
        break;
      case MEDIA_TYPE_REMOTE_VIDEO:
        this.meetings[ID] = {...meeting, remoteVideo: stream};
        break;
      case MEDIA_TYPE_LOCAL_SHARE:
        this.meetings[ID] = {...meeting, localShare: {stream}};
        break;
      case MEDIA_TYPE_REMOTE_SHARE:
        this.meetings[ID] = {...meeting, remoteShareStream: stream};
        break;
      case EVENT_REMOTE_SHARE_START:
        // Only activate the remote stream when get get the start notification
        this.meetings[ID] = {...meeting, remoteShare: meeting.remoteShareStream};
        break;
      case EVENT_REMOTE_SHARE_STOP:
        // Remove remote share on stop event
        this.meetings[ID] = {...meeting, remoteShare: null};
        break;
      default:
        break;
    }
  }

  /**
   * Stops the tracks of the given media stream.
   *
   * @see {@link MediaStream|https://developer.mozilla.org/en-US/docs/Web/API/MediaStream}.
   *
   * @private
   * @static
   * @param {MediaStream} stream Media stream for which to stop tracks
   */
  // eslint-disable-next-line class-methods-use-this
  stopStream(stream) {
    logger.debug('MEETING', undefined, 'stopStream()', 'called');
    if (stream && stream.getTracks) {
      const tracks = stream.getTracks();

      tracks.forEach((track) => track.stop());
    }
  }

  /**
   * Update the meeting object by removing all media.
   *
   * @private
   * @param {string} ID ID of the meeting to update
   */
  removeMedia(ID) {
    logger.debug('MEETING', ID, 'removeMedia()', ['called with', {ID}]);
    if (this.meetings && this.meetings[ID]) {
      this.stopStream(this.meetings[ID].localAudio.stream);
      this.stopStream(this.meetings[ID].localVideo.stream);
      this.stopStream(this.meetings[ID].localShare.stream);
      this.stopStream(this.meetings[ID].disabledLocalAudio);
      this.stopStream(this.meetings[ID].disabledLocalVideo);
    }

    this.meetings[ID] = {
      ...this.meetings[ID],
      localAudio: {
        stream: null,
        permission: null,
      },
      localVideo: {
        stream: null,
        permission: null,
      },
      localShare: {
        stream: null,
      },
      remoteAudio: null,
      remoteVideo: null,
      remoteShare: null,
      cameraID: null,
      microphoneID: null,
      speakerID: null,
      settings: {
        visible: false,
        preview: {
          video: null,
          audio: null,
        },
      },
    };
  }

  /**
   * Returns a promise of a meeting title for a given destination.
   * Supported destinations are person ID, room ID and SIP URI.
   *
   * @private
   * @param {string} destination Virtual meeting destination
   * @returns {Promise.<string>} Promise to the tile of the meeting at the destination
   */
  async fetchMeetingTitle(destination) {
    const {id, type} = deconstructHydraId(destination);
    let meetingTitle = destination;

    if (type === HYDRA_ID_TYPE_PEOPLE) {
      const {displayName} = await this.datasource.people.get(id);

      meetingTitle = displayName;
    } else if (type === HYDRA_ID_TYPE_ROOM) {
      // One must use a Hydra ID when calling `get` on rooms.
      // It has both the convo ID and cluster name in it.
      const {title} = await this.datasource.rooms.get(destination);

      meetingTitle = title;
    } else {
      try {
        const people = await this.datasource.people.list({email: destination});

        if (people.items) {
          const {displayName} = people.items[0];

          meetingTitle = displayName;
        }
        // eslint-disable-next-line no-empty
      } catch (error) {}
    }

    return meetingTitle;
  }

  /**
   * Creates meeting and returns an observable to the new meeting data.
   *
   * @param {string} destination Destination where to start the meeting at
   * @returns {Observable.<Meeting>} Observable stream that emits data of the newly created meeting
   */
  createMeeting(destination) {
    const newMeeting$ = from(this.datasource.meetings.create(destination)).pipe(
      map(({id, meetingInfo: {meetingName}}) => ({
        ID: id,
        title: meetingName,
        localAudio: {
          stream: null,
          permission: null,
        },
        localVideo: {
          stream: null,
          permission: null,
        },
        localShare: {
          stream: null,
        },
        remoteAudio: null,
        remoteVideo: null,
        remoteShare: null,
        showRoster: null,
        settings: {
          visible: false,
          preview: {
            audio: null,
            video: null,
          },
        },
        state: MeetingState.NOT_JOINED,
        cameraID: null,
        microphoneID: null,
        speakerID: null,
      })),
      // if not provided by the sdk, compute a meeting title
      concatMap((meeting) => (
        meeting.title
          ? of(meeting)
          : from(this.fetchMeetingTitle(destination)).pipe(
            map((title) => ({...meeting, title})),
          )
      )),
    );

    return newMeeting$.pipe(
      chainWith((meeting) => this.getLocalMedia(meeting.ID).pipe(
        map((localMedia) => ({
          ...meeting,
          ...localMedia,
        })),
      )),
      tap((meeting) => {
        const sdkMeeting = this.fetchMeeting(meeting.ID);

        this.meetings[meeting.ID] = meeting;
        sdkMeeting.emit(EVENT_MEETING_UPDATED, meeting);
      }),
      catchError((err) => {
        // eslint-disable-next-line no-console
        console.error(`Unable to create a meeting with "${destination}"`, err);
        throw err;
      }),
    );
  }

  /**
   * Returns a SDK meeting object retrieved from the collection.
   *
   * @private
   * @param {string} ID ID of the meeting to fetch.
   * @returns {object} The SDK meeting object from the meetings collection.
   */
  fetchMeeting(ID) {
    logger.debug('MEETING', ID, 'fetchMeeting()', ['called with', {ID}]);

    return this.datasource.meetings.getMeetingByType('id', ID);
  }

  /**
   * Attempts to join the meeting of the given meeting ID.
   * If the meeting is successfully joined, a ready event is dispatched.
   *
   * @param {string} ID  ID of the meeting to join
   * @param {object} [options]  Options for joining
   * @param {string} [options.name]  Username for meeting
   * @param {string} [options.password]  Meeting guest password
   * @param {string} [options.hostKey]  Meeting host key
   */
  async joinMeeting(ID, options = {}) {
    logger.debug('MEETING', ID, 'joinMeeting()', ['called with', {ID, options}]);
    try {
      const sdkMeeting = this.fetchMeeting(ID);

      sdkMeeting.meetingFiniteStateMachine.reset();
      logger.debug('MEETING', ID, 'joinMeeting()', ['calling sdkMeeting.join() with', {pin: options.password, moderator: false, name: options.name}]);
      await sdkMeeting.join({
        pin: options.hostKey || options.password,
        moderator: !!(options.hostKey),
        name: options.name,
      });
    } catch (error) {
      if (error.stack.includes('Meeting requires a moderator pin or guest')) {
        const opts = error.joinOptions || {};

        this.updateMeeting(ID, () => (
          {
            passwordRequired: true,
            invalidPassword: !!opts.pin && !opts.moderator,
            invalidHostKey: !!opts.pin && opts.moderator,
          }));
      } else {
        // eslint-disable-next-line no-console
        console.error(`Unable to join meeting "${ID}"`, error);
      }
    }
  }

  /**
   * Attempts to leave the meeting of the given meeting ID.
   * If the user had left the meeting successfully, a stopped event is dispatched.
   *
   * @param {string} ID ID of the meeting to leave from
   */
  async leaveMeeting(ID) {
    logger.debug('MEETING', ID, 'leaveMeeting()', ['called with', {ID}]);
    try {
      const sdkMeeting = this.fetchMeeting(ID);

      this.removeMedia(ID);

      logger.debug('MEETING', ID, 'leaveMeeting()', 'calling sdkMeeting.leave()');
      await sdkMeeting.leave();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Unable to leave from the meeting "${ID}"`, error);
    }
  }

  /**
   * Attempts to mute the microphone of the given meeting ID.
   * If the microphone is successfully muted, an audio mute event is dispatched.
   *
   * @private
   * @param {string} ID ID of the meeting to mute audio
   */
  async handleLocalAudio(ID) {
    logger.debug('MEETING', ID, 'handleLocalAudio()', ['called with', {ID}]);
    try {
      await this.updateMeeting(ID, async (meeting, sdkMeeting) => {
        const isInSession = !!meeting.remoteAudio;
        const audioDisabled = !!this.meetings[ID].disabledLocalAudio;
        const audioEnabled = !!meeting.localAudio.stream;
        let updates;

        if (audioEnabled) {
          // Mute the audio only if there is an active meeting
          if (isInSession) {
            logger.debug('MEETING', ID, 'handleLocalAudio()', 'calling sdkMeeting.muteAudio()');
            await sdkMeeting.muteAudio();
          }

          // Store the current local audio stream to avoid an extra request call
          updates = {
            disabledLocalAudio: meeting.localAudio.stream,
            localAudio: {
              stream: null,
            },
          };
        } else if (audioDisabled) {
          // Unmute the audio only if there is an active meeting
          if (isInSession) {
            logger.debug('MEETING', ID, 'handleLocalAudio()', 'calling sdkMeeting.unmuteAudio()');
            await sdkMeeting.unmuteAudio();
          }

          // Retrieve the stored local audio stream
          updates = {
            disabledLocalAudio: null,
            localAudio: {
              stream: meeting.disabledLocalAudio,
            },
          };
        }

        logger.debug('MEETING', ID, 'handleLocalAudio()', ['meeting updated with localAudio', {updates}]);

        return updates;
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Unable to update local audio settings for meeting "${ID}"`, error);
    }
  }

  /**
   * Attempts to mute the camera of the given meeting ID.
   * If the camera is successfully muted, a video mute event is dispatched.
   *
   * @private
   * @param {string} ID ID of the meeting to mute video
   */
  async handleLocalVideo(ID) {
    logger.debug('MEETING', ID, 'handleLocalVideo()', ['called with', {ID}]);
    try {
      await this.updateMeeting(ID, async (meeting, sdkMeeting) => {
        const isInSession = !!meeting.remoteVideo;
        const videoEnabled = !!meeting.localVideo.stream;
        const videoDisabled = !!meeting.disabledLocalVideo;
        let updates;

        if (videoEnabled) {
          // Mute the video only if there is an active meeting
          if (isInSession) {
            logger.debug('MEETING', ID, 'handleLocalVideo()', 'calling sdkMeeting.muteVideo()');
            await sdkMeeting.muteVideo();
          }

          // Store the current local video stream to avoid an extra request call
          updates = {
            localVideo: {stream: null},
            disabledLocalVideo: meeting.localVideo.stream,
          };
        } else if (videoDisabled) {
          // Unmute the video only if there is an active meeting
          if (isInSession) {
            logger.debug('MEETING', ID, 'handleLocalVideo()', 'calling sdkMeeting.unmuteVideo()');
            await sdkMeeting.unmuteVideo();
          }

          // Retrieve the stored local video stream
          updates = {
            localVideo: {stream: meeting.disabledLocalVideo},
            disabledLocalVideo: null,
          };
        }

        logger.debug('MEETING', ID, 'handleLocalVideo()', ['meeting updated with localVideo', {updates}]);

        return updates;
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Unable to update local video settings for meeting "${ID}"`, error);
    }
  }

  /**
   * Attempts to start/stop screen sharing to the given meeting ID.
   * If successful, a sharing start/stop event is dispatched.
   *
   * @private
   * @param {string} ID ID of the meeting to start/stop sharing
   */
  async handleLocalShare(ID) {
    logger.debug('MEETING', ID, 'handleLocalShare()', ['called with', {ID}]);
    await this.updateMeeting(ID, async (meeting, sdkMeeting) => {
      let updates;

      const handleSdkError = (error) => {
        // eslint-disable-next-line no-console
        console.warn(`Unable to update local share stream for meeting "${ID}"`, error);

        this.stopStream(meeting.localShare.stream);
        updates = {localShare: {stream: null}};
        this.updateMeeting(ID, async () => ({localShare: {stream: null}}));
      };

      //
      // Workflow:
      // To enable or to disable the local sharing stream based on toggle state.
      // Will stop sharing stream and reset UI state when error happens
      //
      if (!sdkMeeting.canUpdateMedia()) {
        // eslint-disable-next-line no-console
        console.error(`Unable to update screen share for meeting "${ID}" due to unstable connection.`);
      } else if (meeting.localShare.stream) {
        this.stopStream(meeting.localShare.stream);

        sdkMeeting.updateShare({sendShare: false, receiveShare: true}).catch(handleSdkError);

        updates = {localShare: {stream: null}};
      } else {
        const [, localShare] = await sdkMeeting.getMediaStreams({sendShare: true});

        sdkMeeting.updateShare({
          stream: localShare,
          sendShare: true,
          receiveShare: true,
        }).catch(handleSdkError);

        updates = {localShare: {stream: localShare}};
      }

      logger.debug('MEETING', ID, 'handleLocalShare()', ['meeting updated with localShare', {updates}]);

      return updates;
    });
  }

  /**
   * Attempts to toggle roster to the given meeting ID.
   * A roster toggle event is dispatched.
   *
   * @param {string} ID ID of the meeting to toggle roster
   */
  toggleRoster(ID) {
    logger.debug('MEETING', ID, 'toggleRoster()', ['called with', {ID}]);

    return this.updateMeeting(ID, ({showRoster}) => ({showRoster: !showRoster}));
  }

  /**
   * Toggles the settings.visible flag of the given meeting ID.
   * A settings toggle event is dispatched.
   *
   * @param {string} ID  Meeting ID
   */
  async toggleSettings(ID) {
    logger.debug('MEETING', ID, 'toggleSettings()', ['called with', {ID}]);
    await this.updateMeeting(ID, async (meeting, sdkMeeting) => {
      let updates;
      const openingSettings = !meeting.settings.visible;

      if (openingSettings) {
        // Populate the preview streams with clones of the meeting streams
        // so that switching cameras/microphones in preview doesn't stop the meeting streams.
        // If the camera or microphone are muted, start them for the preview.
        const videoStream = meeting.localVideo.stream || meeting.disabledLocalVideo;
        const audioStream = meeting.localAudio.stream || meeting.disabledLocalAudio;

        updates = {
          settings: {
            visible: true,
            preview: {
              video: videoStream && videoStream.clone(),
              audio: audioStream && audioStream.clone(),
            },
          },
        };
      } else {
        // When closing settings, stop the existing meeting streams
        // and replace them with the last preview streams.
        this.stopStream(meeting.localVideo.stream);
        this.stopStream(meeting.localAudio.stream);
        updates = {
          settings: {
            visible: false,
          },
          localVideo: {
            stream: meeting.localVideo.stream && meeting.settings.preview.video,
          },
          disabledLocalVideo: meeting.disabledLocalVideo && meeting.settings.preview.video,
          localAudio: {
            stream: meeting.localAudio.stream && meeting.settings.preview.audio,
          },
          disabledLocalAudio: meeting.disabledLocalAudio && meeting.settings.preview.audio,
        };

        if (meeting.state === MeetingState.JOINED) {
          await sdkMeeting.updateVideo({
            stream: meeting.settings.preview.video,
            receiveVideo: mediaSettings.receiveVideo,
            sendVideo: mediaSettings.sendVideo,
          });

          await sdkMeeting.updateAudio({
            stream: meeting.settings.preview.audio,
            receiveAudio: mediaSettings.receiveAudio,
            sendAudio: mediaSettings.sendAudio,
          });
        }
      }

      logger.debug('MEETING', ID, 'toggleSettings()', ['meeting updated with toggleSettings', {updates}]);

      return updates;
    });
  }

  /**
   * Switches the camera control.
   *
   * @param {string} ID Meeting ID
   * @param {string} cameraID ID of the camera to switch to
   */
  async switchCamera(ID, cameraID) {
    logger.debug('MEETING', ID, 'switchCamera()', ['called with', {ID, cameraID}]);
    await this.updateMeeting(ID, async (meeting) => {
      let updates;

      this.stopStream(meeting.settings.preview.video);
      const {stream, permission} = await this.getStream(
        ID,
        {sendVideo: true},
        {video: {deviceId: cameraID}},
      ).toPromise();

      if (stream) {
        updates = {
          settings: {
            preview: {
              stream,
            },
          },
          cameraID,
        };
      } else {
        throw new Error(`Could not change camera, permission not granted: ${permission}`);
      }

      logger.debug('MEETING', ID, 'switchCamera()', ['meeting update with switchCamera', {updates}]);

      return updates;
    });
  }

  /**
   * Switches the microphone control.
   *
   * @param {string} ID Meeting ID
   * @param {string} microphoneID ID of the microphone to switch to
   */
  async switchMicrophone(ID, microphoneID) {
    logger.debug('MEETING', ID, 'switchMicrophone()', ['called with', {ID, microphoneID}]);
    await this.updateMeeting(ID, async (meeting) => {
      let updates;

      this.stopStream(meeting.settings.preview.audio);
      const {stream, permission} = await this.getStream(
        ID,
        {sendAudio: true},
        {audio: {deviceId: microphoneID}},
      ).toPromise();

      if (stream) {
        updates = {
          settings: {
            preview: {
              audio: stream,
            },
          },
          microphoneID,
        };
      } else {
        throw new Error(`Could not change microphone, permission not granted: ${permission}`);
      }

      logger.debug('MEETING', ID, 'switchMicrophone()', ['meeting update with switchMicrophone', {updates}]);

      return updates;
    });
  }

  /**
   * Switches the speaker control.
   *
   * @param {string} ID  Meeting ID
   * @param {string} speakerID  ID of the speaker device to switch to
   * @private
   */
  async switchSpeaker(ID, speakerID) {
    logger.debug('MEETING', ID, 'switchSpeaker()', ['called with', {ID, speakerID}]);

    return this.updateMeeting(ID, () => ({speakerID}));
  }

  /**
   * Allows user to join meeting without allowing camera access
   *
   * @param {string}  ID Meeting ID
   */
  ignoreVideoAccessPrompt(ID) {
    logger.debug('MEETING', ID, 'ignoreVideoAccessPrompt()', ['called with', {ID}]);
    const meeting = this.meetings[ID];

    if (meeting.localVideo.ignoreMediaAccessPrompt) {
      meeting.localVideo.ignoreMediaAccessPrompt();
    } else {
      // eslint-disable-next-line no-console
      console.error('Can not ignore video prompt in current state:', meeting.localVideo.permission);
    }
  }

  /**
   * Allows user to join meeting without allowing microphone access
   *
   * @param {string} ID  Meeting ID
   */
  ignoreAudioAccessPrompt(ID) {
    logger.debug('MEETING', ID, 'ignoreAudioAccessPrompt()', ['called with', {ID}]);
    const meeting = this.meetings[ID];

    if (meeting.localAudio.ignoreMediaAccessPrompt) {
      meeting.localAudio.ignoreMediaAccessPrompt();
    } else {
      // eslint-disable-next-line no-console
      console.error('Can not ignore audio prompt in current state:', meeting.localAudio.permission);
    }
  }

  /**
   * Sends the local media streams to the SDK
   *
   * @async
   * @private
   * @param {string} ID  Meeting id
   * @returns {Promise} Resolves when the local media streams have been successfully sent to the SDK.
   */
  async addMedia(ID) {
    logger.debug('MEETING', ID, 'addMedia()', ['called with', {ID}]);
    const sdkMeeting = this.fetchMeeting(ID);
    const localStream = new MediaStream();
    const localAudio = this.meetings[ID].localAudio.stream
      || this.meetings[ID].disabledLocalAudio;
    const localVideo = this.meetings[ID].localVideo.stream
      || this.meetings[ID].disabledLocalVideo;

    if (localAudio) {
      localAudio.getAudioTracks().forEach((track) => localStream.addTrack(track));
    }

    if (localVideo) {
      localVideo.getVideoTracks().forEach((track) => localStream.addTrack(track));
    }

    logger.debug('MEETING', ID, 'addMedia()', ['calling sdkMeeting.addMedia()', {localStream, mediaSettings}]);
    await sdkMeeting.addMedia({localStream, mediaSettings});

    if (!this.meetings[ID].localAudio.stream) {
      logger.debug('MEETING', ID, 'addMedia()', 'calling sdkMeeting.muteAudio()');
      await sdkMeeting.muteAudio();
    }

    if (!this.meetings[ID].localVideo.stream) {
      logger.debug('MEETING', ID, 'addMedia()', 'calling sdkMeeting.muteVideo()');
      await sdkMeeting.muteVideo();
    }
  }

  /**
   * Returns an observable that emits meeting data of the given ID.
   *
   * @param {string} ID ID of meeting to get
   * @returns {Observable.<Meeting>} Observable stream that emits meeting data of the given ID
   */
  getMeeting(ID) {
    logger.debug('MEETING', ID, 'getMeeting()', ['called with', {ID}]);
    if (!(ID in this.getMeetingObservables)) {
      const sdkMeeting = this.fetchMeeting(ID);
      const getMeeting$ = Observable.create((observer) => {
        if (this.meetings[ID]) {
          logger.debug('MEETING', ID, 'getMeeting()', ['initial meeting object', this.meetings[ID]]);
          observer.next(this.meetings[ID]);
        } else {
          logger.error('MEETING', ID, 'getMeeting()', `Could not find meeting with ID "${ID}"`);
          observer.error(new Error(`Could not find meeting with ID "${ID}"`));
        }

        observer.complete();
      });

      const meetingUpdateEvent$ = fromEvent(sdkMeeting, EVENT_MEETING_UPDATED).pipe(
        tap(() => logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_MEETING_UPDATED, 'event'])),
        tap((meeting) => {
          this.meetings[ID] = meeting;
        }),
      );

      const meetingWithMediaReadyEvent$ = fromEvent(sdkMeeting, EVENT_MEDIA_READY).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_MEDIA_READY, 'event']);
        }),
        filter((event) => MEDIA_EVENT_TYPES.includes(event.type)),
        map((event) => this.attachMedia(ID, event)),
      );

      const meetingWithMediaStoppedEvent$ = fromEvent(sdkMeeting, EVENT_MEDIA_STOPPED).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_MEDIA_STOPPED, 'event']);
          this.removeMedia(ID);
        }),
      );

      const meetingWithMediaShareEvent$ = fromEvent(sdkMeeting, EVENT_REMOTE_SHARE_START).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_REMOTE_SHARE_START, 'event']);
          this.attachMedia(ID, {type: EVENT_REMOTE_SHARE_START});
        }),
      );

      const meetingWithMediaStoppedShareEvent$ = fromEvent(sdkMeeting, EVENT_REMOTE_SHARE_STOP)
        .pipe(
          tap(() => {
            logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_REMOTE_SHARE_STOP, 'event']);
            this.attachMedia(ID, {type: EVENT_REMOTE_SHARE_STOP});
          }),
        );

      const meetingWithLocalShareStoppedEvent$ = fromEvent(sdkMeeting, EVENT_LOCAL_SHARE_STOP).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_LOCAL_SHARE_STOP, 'event']);
          this.stopStream(this.meetings[ID].localShare.stream);
          this.meetings[ID].localShare.stream = null;
        }),
      );

      const meetingWithLocalShareStartedEvent$ = fromEvent(sdkMeeting, EVENT_LOCAL_SHARE_START)
        .pipe(
          tap(() => {
            logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_LOCAL_SHARE_START, 'event']);
          }),
        );

      const meetingWithSwitchCameraEvent$ = fromEvent(sdkMeeting, EVENT_CAMERA_SWITCH).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_CAMERA_SWITCH, 'event']);
        }),
      );

      const meetingWithSwitchMicrophoneEvent$ = fromEvent(sdkMeeting, EVENT_MICROPHONE_SWITCH).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['received', EVENT_MICROPHONE_SWITCH, 'event']);
        }),
      );

      const meetingStateChange$ = fromEvent(sdkMeeting, EVENT_STATE_CHANGE).pipe(
        tap((event) => {
          const sdkState = event.payload.currentState;
          let state;

          if (sdkState === 'INITIALIZING') {
            logger.debug('MEETING', ID, 'getMeeting()', 'meeting state change INITIALIZING');
            state = 'JOINING';
          } else if (sdkState === 'ACTIVE') {
            logger.debug('MEETING', ID, 'getMeeting()', 'meeting state change ACTIVE');
            state = MeetingState.JOINED;
            // do not await on this, otherwise the emitted message won't contain an updated state
            this.addMedia(ID).catch((error) => {
              // eslint-disable-next-line no-console
              console.error(`Unable to add media to the meeting "${ID}"`, error);
            });
          } else if (sdkState === 'INACTIVE') {
            logger.debug('MEETING', ID, 'getMeeting()', 'meeting state change INACTIVE');
            state = MeetingState.LEFT;
          } else {
            state = this.meetings[ID].state;
          }

          logger.debug('MEETING', ID, 'getMeeting()', ['changing meeting state to ', {state}]);
          this.meetings[ID] = {...this.meetings[ID], state};
          logger.debug('MEETING', ID, 'getMeeting()', ['changed meeting state to ', {state}]);
        }),
      );

      const meetingsWithEvents$ = merge(
        meetingUpdateEvent$,
        meetingWithMediaReadyEvent$,
        meetingWithMediaStoppedEvent$,
        meetingWithLocalShareStoppedEvent$,
        meetingWithMediaShareEvent$,
        meetingWithMediaStoppedShareEvent$,
        meetingStateChange$,
        meetingWithSwitchCameraEvent$,
        meetingWithSwitchMicrophoneEvent$,
        meetingWithLocalShareStartedEvent$,
      ).pipe(map(() => this.meetings[ID]), // Return a meeting object from event
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['meeting after event is ', this.meetings[ID]]);
        }));

      const getMeetingWithEvents$ = concat(getMeeting$, meetingsWithEvents$).pipe(
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['meeting with events is ', this.meetings[ID]]);
        }),
      );

      // Convert to a multicast observable
      this.getMeetingObservables[ID] = getMeetingWithEvents$.pipe(
        publishReplay(1),
        refCount(),
        takeWhile((meeting) => meeting.state && meeting.state !== MeetingState.LEFT, true),
        tap(() => {
          logger.debug('MEETING', ID, 'getMeeting()', ['emitting updated meeting object', this.meetings[ID]]);
        }),
      );
    }

    return this.getMeetingObservables[ID];
  }

  /**
   * A callback that returns an updated meeting
   *
   * @callback UpdateMeetingCallback
   * @param {Meeting} meeting  Original meeting object
   * @returns {Promise<Meeting>} Updated meeting object
   */

  /**
   * Updates a meeting and notifies listeners
   *
   * @private
   * @async
   * @param {string} ID  Id of the meeting to update.
   * @param {UpdateMeetingCallback} updater  Function to update the meeting
   */

  async updateMeeting(ID, updater) {
    logger.debug('MEETING', ID, 'updateMeeting()', ['called with', {ID, updater}]);
    const sdkMeeting = this.fetchMeeting(ID);
    const meeting = this.meetings[ID];

    if (!sdkMeeting || !meeting) {
      throw new Error(`Could not find meeting with ID "${ID}"`);
    }

    const updates = await updater(meeting, sdkMeeting);

    deepMerge(meeting, updates);

    logger.debug('MEETING', ID, 'updateMeeting()', ['meeting updated with', EVENT_MEETING_UPDATED, 'event', 'meeting object', {meeting}]);
    sdkMeeting.emit(EVENT_MEETING_UPDATED, meeting);
  }

  /**
   * Displays the names of the available controls.
   *
   * @returns {string[]} Array containing the control names supported.
   */
  supportedControls() {
    return Object.keys(this.meetingControls);
  }

  /**
   * Clears the password required flag.
   *
   * @async
   * @param {string} ID  Id of the meeting
   */
  async clearPasswordRequiredFlag(ID) {
    logger.debug('MEETING', ID, 'clearPasswordRequiredFlag()', ['called with', {ID}]);
    await this.updateMeeting(ID, async () => ({passwordRequired: false}));
  }

  /**
   * Sets the invalidPassword flag to false.
   *
   * @async
   * @param {string} ID  Id of the meeting
   */
  async clearInvalidPasswordFlag(ID) {
    logger.debug('MEETING', ID, 'clearInvalidPasswordFlag()', ['called with', {ID}]);
    await this.updateMeeting(ID, async () => ({invalidPassword: false}));
  }

  /**
   * Sets the invalidHostKey flag to false.
   *
   * @async
   * @param {string} ID  Id of the meeting
   */
  async clearInvalidHostKeyFlag(ID) {
    await this.updateMeeting(ID, async () => ({invalidHostKey: false}));
  }
}

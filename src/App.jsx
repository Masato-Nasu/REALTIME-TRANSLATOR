import { useEffect, useRef, useState } from 'react';

const CONNECTION_LABELS = {
  disconnected: '未接続',
  connecting: '接続中',
  connected: '翻訳中',
  error: 'エラー',
};

const VOLUME_LEVELS = [
  { label: '標準', gain: 1 },
  { label: '大', gain: 1.5 },
  { label: '最大', gain: 2 },
];

function App() {
  const [connectionState, setConnectionState] = useState('disconnected');
  const [statusMessage, setStatusMessage] = useState('準備完了');
  const [errorMessage, setErrorMessage] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [subtitleText, setSubtitleText] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [volumeLevel, setVolumeLevel] = useState(1);
  const [direction, setDirection] = useState('ja-en');
  const [apiKey, setApiKey] = useState('');

  const mediaStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const audioContextRef = useRef(null);
  const remoteSourceRef = useRef(null);
  const gainNodeRef = useRef(null);
  const startingRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const handoffConnectionRef = useRef(null);

  const applyOutputGain = (enabled = voiceEnabled, level = volumeLevel) => {
    if (!gainNodeRef.current || !audioContextRef.current) return;
    gainNodeRef.current.gain.setTargetAtTime(
      enabled ? VOLUME_LEVELS[level].gain : 0,
      audioContextRef.current.currentTime,
      0.01
    );
  };

  const prepareAudioOutput = async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;

    if (!audioContextRef.current) {
      const context = new AudioContextClass({ latencyHint: 'interactive' });
      const gain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      gain.connect(limiter);
      limiter.connect(context.destination);
      audioContextRef.current = context;
      gainNodeRef.current = gain;
      gain.gain.value = VOLUME_LEVELS[volumeLevel].gain;
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return true;
  };

  const closeConnection = (peerConnection, dataChannel) => {
    try {
      dataChannel?.close();
    } catch {
      // Already closed.
    }

    try {
      peerConnection?.close();
    } catch {
      // Already closed.
    }
  };

  const releaseResources = () => {
    closeConnection(peerConnectionRef.current, dataChannelRef.current);
    peerConnectionRef.current = null;
    dataChannelRef.current = null;

    if (handoffConnectionRef.current) {
      closeConnection(
        handoffConnectionRef.current.peerConnection,
        handoffConnectionRef.current.dataChannel
      );
      handoffConnectionRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
    remoteSourceRef.current?.disconnect();
    remoteSourceRef.current = null;
  };

  const stopSession = () => {
    connectionGenerationRef.current += 1;
    releaseResources();
    startingRef.current = false;
    setIsStarting(false);
    setIsActive(false);
    setConnectionState('disconnected');
    setStatusMessage('セッション終了');
  };

  useEffect(() => {
    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudioRef.current = remoteAudio;

    return () => {
      connectionGenerationRef.current += 1;
      releaseResources();
      audioContextRef.current?.close();
    };
  }, []);

  const getLiveMicrophoneStream = async () => {
    const currentStream = mediaStreamRef.current;
    const currentTrack = currentStream?.getAudioTracks?.()[0];

    if (
      currentStream?.active &&
      currentTrack &&
      currentTrack.readyState === 'live'
    ) {
      return currentStream;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    mediaStreamRef.current = stream;
    return stream;
  };

  const startSession = async (
    requestedDirection = direction,
    { handoff = false } = {}
  ) => {
    if (startingRef.current) return;

    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      setErrorMessage('OpenAI API KEYを入力してください。');
      setConnectionState('error');
      setStatusMessage('API KEYが必要です');
      return;
    }

    const previousConnection =
      handoff && peerConnectionRef.current
        ? {
            peerConnection: peerConnectionRef.current,
            dataChannel: dataChannelRef.current,
          }
        : null;

    if (previousConnection) {
      handoffConnectionRef.current = previousConnection;
      remoteAudioRef.current?.pause();
    }

    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;

    startingRef.current = true;
    setIsStarting(true);
    setIsActive(false);
    setConnectionState('connecting');
    setStatusMessage(handoff ? '翻訳方向を切り替え中' : '接続中');
    setErrorMessage('');
    setSubtitleText('');

    let peerConnection = null;
    let dataChannel = null;

    try {
      const canBoostAudio = await prepareAudioOutput();
      const targetLanguage =
        requestedDirection === 'ja-en' ? 'en' : 'ja';

      const sessionResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetLanguage,
          apiKey: trimmedApiKey,
        }),
      });

      const session = await sessionResponse.json();

      if (!sessionResponse.ok || !session.clientSecret) {
        throw new Error(session.error || '翻訳セッションを作成できませんでした。');
      }

      const sourceStream = await getLiveMicrophoneStream();

      peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;
      peerConnection.addTrack(sourceStream.getAudioTracks()[0], sourceStream);

      peerConnection.ontrack = ({ streams }) => {
        if (
          connectionGenerationRef.current !== generation ||
          peerConnectionRef.current !== peerConnection ||
          !remoteAudioRef.current
        ) {
          return;
        }

        remoteSourceRef.current?.disconnect();
        if (canBoostAudio && audioContextRef.current && gainNodeRef.current) {
          remoteAudioRef.current.pause();
          remoteAudioRef.current.srcObject = null;
          remoteSourceRef.current =
            audioContextRef.current.createMediaStreamSource(streams[0]);
          remoteSourceRef.current.connect(gainNodeRef.current);
          applyOutputGain();
        } else {
          remoteAudioRef.current.srcObject = streams[0];
          remoteAudioRef.current.muted = !voiceEnabled;
          remoteAudioRef.current.play().catch(() => {});
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (
          connectionGenerationRef.current !== generation ||
          peerConnectionRef.current !== peerConnection
        ) {
          return;
        }

        if (peerConnection.connectionState === 'connected') {
          if (handoffConnectionRef.current) {
            closeConnection(
              handoffConnectionRef.current.peerConnection,
              handoffConnectionRef.current.dataChannel
            );
            handoffConnectionRef.current = null;
          }

          startingRef.current = false;
          setIsStarting(false);
          setIsActive(true);
          setConnectionState('connected');
          setStatusMessage(
            requestedDirection === 'ja-en'
              ? '日本語を話してください'
              : 'Speak English'
          );
        }

        if (peerConnection.connectionState === 'failed') {
          releaseResources();
          startingRef.current = false;
          setIsStarting(false);
          setIsActive(false);
          setErrorMessage('OpenAIとのWebRTC接続に失敗しました。');
          setConnectionState('error');
          setStatusMessage('エラー');
        }
      };

      dataChannel = peerConnection.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      dataChannel.onmessage = ({ data }) => {
        if (
          connectionGenerationRef.current !== generation ||
          peerConnectionRef.current !== peerConnection
        ) {
          return;
        }

        try {
          const event = JSON.parse(data);

          if (event.type === 'session.output_transcript.delta') {
            setSubtitleText((current) => current + event.delta);
          }

          if (event.type === 'error') {
            setErrorMessage(
              event.error?.message || 'Realtime翻訳でエラーが発生しました。'
            );
          }
        } catch {
          // 字幕以外のイベントは無視
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch(
        'https://api.openai.com/v1/realtime/translations/calls',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        }
      );

      if (!sdpResponse.ok) {
        throw new Error(
          `OpenAI WebRTC接続に失敗しました（${sdpResponse.status}）。`
        );
      }

      if (
        connectionGenerationRef.current !== generation ||
        peerConnectionRef.current !== peerConnection
      ) {
        closeConnection(peerConnection, dataChannel);
        return;
      }

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: await sdpResponse.text(),
      });
    } catch (error) {
      if (
        connectionGenerationRef.current === generation &&
        peerConnectionRef.current === peerConnection
      ) {
        releaseResources();
      } else {
        closeConnection(peerConnection, dataChannel);
      }

      startingRef.current = false;
      setIsStarting(false);
      setIsActive(false);
      setErrorMessage(error.message || '接続に失敗しました。');
      setConnectionState('error');
      setStatusMessage('エラー');
    }
  };

  const handleStartStop = () => {
    if (isActive) {
      stopSession();
      return;
    }

    startSession(direction);
  };

  const handleStartStopClick = (event) => {
    // Pointer input is handled on pointerup below. Keep native keyboard activation.
    if (event.detail === 0) {
      handleStartStop();
    }
  };

  const handleVoiceToggle = () => {
    setVoiceEnabled((current) => {
      const next = !current;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.muted = !next;
      }
      applyOutputGain(next, volumeLevel);

      return next;
    });
  };

  const handleVolumeLevel = () => {
    setVolumeLevel((current) => {
      const next = (current + 1) % VOLUME_LEVELS.length;
      applyOutputGain(voiceEnabled, next);
      return next;
    });
  };

  const handleDirectionToggle = async () => {
    if (isStarting) return;

    const nextDirection =
      direction === 'ja-en' ? 'en-ja' : 'ja-en';

    setDirection(nextDirection);
    setSubtitleText('');
    setErrorMessage('');

    if (isActive) {
      await startSession(nextDirection, { handoff: true });
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {direction === 'ja-en'
              ? '日本語 → ENGLISH'
              : 'ENGLISH → 日本語'}
          </p>
          <h1>Realtime Translator</h1>
        </div>
        <div className={`connection-badge connection-${connectionState}`}>
          {CONNECTION_LABELS[connectionState]}
        </div>
      </header>

      <div
        style={{
          display: 'grid',
          gap: '7px',
          padding: '14px 16px',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          borderRadius: '16px',
          background: 'rgba(15, 23, 42, 0.72)',
        }}
      >
        <label
          htmlFor="openai-api-key"
          style={{ color: '#cbd5e1', fontSize: '0.82rem', fontWeight: 700 }}
        >
          OPENAI API KEY — BYOK
        </label>
        <input
          id="openai-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          spellCheck="false"
          disabled={isStarting || isActive}
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: '12px',
            border: '1px solid rgba(148, 163, 184, 0.28)',
            background: '#020817',
            color: '#f8fafc',
            font: 'inherit',
          }}
        />
        <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
          キーは保存しません。セッション作成時にのみバックエンドへ送信します。
        </span>
      </div>

      <button
        className="direction-toggle"
        onClick={handleDirectionToggle}
        disabled={isStarting}
      >
        <span>
          {direction === 'ja-en'
            ? '日本語 → ENGLISH'
            : 'ENGLISH → 日本語'}
        </span>
        <strong>⇄ SWITCH</strong>
      </button>

      <main className="subtitle-area">
        <div className="subtitle-text">
          {subtitleText ||
            (direction === 'ja-en'
              ? 'English translation will appear here.'
              : '日本語訳がここに表示されます。')}
        </div>
      </main>

      <footer className="controls">
        <button
          className={`voice-toggle ${voiceEnabled ? 'voice-on' : 'voice-off'}`}
          onClick={handleVoiceToggle}
        >
          {voiceEnabled ? '🔊 VOICE ON' : '🔇 VOICE OFF'}
        </button>

        <button className="volume-level" onClick={handleVolumeLevel}>
          <span>🔊 音量</span>
          <strong>{VOLUME_LEVELS[volumeLevel].label}</strong>
          <small>{VOLUME_LEVELS[volumeLevel].gain.toFixed(1)}倍</small>
        </button>

        <button
          className="primary"
          onPointerUp={handleStartStop}
          onClick={handleStartStopClick}
          disabled={isStarting}
        >
          {isActive ? 'STOP' : isStarting ? 'STARTING...' : 'START'}
        </button>
      </footer>

      <div className="status-row">
        <span className="status-label">状態</span>
        <strong>{statusMessage}</strong>
      </div>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
    </div>
  );
}

export default App;

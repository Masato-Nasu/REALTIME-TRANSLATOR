import { useEffect, useRef, useState } from 'react';

const CONNECTION_LABELS = {
  disconnected: '未接続',
  connecting: '接続中',
  connected: '翻訳中',
  error: 'エラー',
};

function App() {
  const [connectionState, setConnectionState] = useState('disconnected');
  const [statusMessage, setStatusMessage] = useState('準備完了');
  const [errorMessage, setErrorMessage] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [subtitleText, setSubtitleText] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [direction, setDirection] = useState('ja-en');

  const mediaStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const startingRef = useRef(false);

  const releaseResources = () => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
  };

  const stopSession = () => {
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
      dataChannelRef.current?.close();
      peerConnectionRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      remoteAudio.pause();
      remoteAudio.srcObject = null;
    };
  }, []);

  const startSession = async (requestedDirection = direction) => {
    if (startingRef.current) return;

    startingRef.current = true;
    setIsStarting(true);
    setConnectionState('connecting');
    setStatusMessage('接続中');
    setErrorMessage('');
    setSubtitleText('');

    try {
      const targetLanguage =
        requestedDirection === 'ja-en' ? 'en' : 'ja';

      const sessionResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetLanguage,
        }),
      });

      const session = await sessionResponse.json();

      if (!sessionResponse.ok || !session.clientSecret) {
        throw new Error(session.error || '翻訳セッションを作成できませんでした。');
      }

      const sourceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = sourceStream;

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;
      peerConnection.addTrack(sourceStream.getAudioTracks()[0], sourceStream);

      peerConnection.ontrack = ({ streams }) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = streams[0];
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
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

      const dataChannel = peerConnection.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      dataChannel.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);

          if (event.type === 'session.output_transcript.delta') {
            setSubtitleText((current) => current + event.delta);
          }
        } catch {
          // 字幕以外のイベントは無視
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpResponse.ok) {
        throw new Error(`OpenAI WebRTC接続に失敗しました（${sdpResponse.status}）。`);
      }

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: await sdpResponse.text(),
      });
    } catch (error) {
      releaseResources();
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

      return next;
    });
  };

  const handleDirectionToggle = async () => {
    if (isStarting) return;

    const nextDirection =
      direction === 'ja-en' ? 'en-ja' : 'ja-en';

    setDirection(nextDirection);
    setSubtitleText('');

    if (isActive) {
      releaseResources();
      startingRef.current = false;
      setIsActive(false);

      await startSession(nextDirection);
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

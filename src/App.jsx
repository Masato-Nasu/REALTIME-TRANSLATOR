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
  const [apiKey, setApiKey] = useState('');

  const mediaStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const startingRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const handoffConnectionRef = useRef(null);

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
    return () => {
      connectionGenerationRef.current += 1;
      releaseResources();
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

        const remoteAudio = remoteAudioRef.current;
        remoteAudio.srcObject = streams[0];
        remoteAudio.muted = !voiceEnabled;

        remoteAudio.play().catch((error) => {
          if (error?.name === 'NotAllowedError') {
            setErrorMessage(
              'Androidで音声再生がブロックされました。VOICE OFF → ON をタップしてください。'
            );
            return;
          }

          setErrorMessage('翻訳音声の再生に失敗しました。');
        });
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
    const next = !voiceEnabled;
    const remoteAudio = remoteAudioRef.current;

    if (remoteAudio) {
      remoteAudio.muted = !next;

      if (next && remoteAudio.srcObject) {
        remoteAudio.play().then(() => {
          setErrorMessage('');
        }).catch((error) => {
          setErrorMessage(
            error?.name === 'NotAllowedError'
              ? 'Androidで音声再生が許可されていません。もう一度VOICE ONをタップしてください。'
              : '翻訳音声の再生に失敗しました。'
          );
        });
      }
    }

    setVoiceEnabled(next);
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
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        aria-hidden="true"
        style={{ display: 'none' }}
      />

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

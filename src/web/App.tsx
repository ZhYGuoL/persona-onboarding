import { useRef, useState } from "react";
import { Phone } from "./Phone.tsx";
import { isConnectLink, openConnectPopup } from "./popup.ts";
import { Reviewer } from "./Reviewer.tsx";
import { type CallControls, useCall, voiceSupported } from "./useCall.ts";
import { useSession } from "./useSession.ts";
import { useVoiceRuns } from "./voiceRuns.ts";

const VOICE = voiceSupported();

export function App() {
  const callRef = useRef<CallControls | null>(null);
  const { view, sendText, sendRaw, reset, fastForward, reviewer } = useSession({
    voice: VOICE,
    onMessage: (msg) => callRef.current?.onServerMessage(msg),
  });
  const call = useCall(sendRaw);
  callRef.current = call;
  const [lagMs, setLagMs] = useState(0);
  const voiceRuns = useVoiceRuns({
    reset,
    sendText: (text) => sendText(text),
    sendRaw,
    dropCall: async () => {
      await reviewer("drop-call");
    },
    call: () => callRef.current ?? call,
    agentTexts: () => view.thread.filter((t) => t.from === "agent").length,
    connected: () => view.connected,
    sessionId: () => view.sessionId,
  });

  const state = view.state as {
    slots?: Record<string, { value: string | null; status: string }>;
    caps?: { voice: boolean };
    call?: { status: string };
  } | null;
  const agent = state?.slots?.agent_name;
  const contactName = agent?.value && agent.status !== "declined" ? agent.value : "Persona";

  return (
    <div className="stage">
      <main className="stage-phone">
        <Phone
          thread={view.thread}
          fresh={view.fresh}
          typing={view.typing}
          now={view.now}
          contactName={contactName}
          connected={view.connected}
          onSend={sendText}
          call={call}
          voiceAvailable={Boolean(state?.caps?.voice)}
          onOpenLink={(url) => {
            if (!isConnectLink(url)) return false;
            return openConnectPopup(url, () => sendRaw({ t: "oauth_closed" }));
          }}
        />
      </main>
      <Reviewer
        state={view.state}
        log={view.log}
        now={view.now}
        sessionId={view.sessionId}
        connected={view.connected}
        onFastForward={(ms) => void fastForward(ms)}
        onReset={() => {
          setLagMs(0);
          void reset();
        }}
        call={call}
        callLive={state?.call?.status === "active"}
        lagMs={lagMs}
        onDropCall={() => void reviewer("drop-call")}
        onLag={(ms) => {
          setLagMs(ms);
          void reviewer("lag", { ms });
        }}
        onOAuth={(outcome) => void reviewer("oauth", { outcome })}
        voiceRuns={voiceRuns}
      />
    </div>
  );
}

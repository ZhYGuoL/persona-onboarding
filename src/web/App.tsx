import { useRef, useState } from "react";
import { Phone } from "./Phone.tsx";
import { Reviewer } from "./Reviewer.tsx";
import { type CallControls, useCall, voiceSupported } from "./useCall.ts";
import { useSession } from "./useSession.ts";

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
      />
    </div>
  );
}

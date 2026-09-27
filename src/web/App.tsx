import { Phone } from "./Phone.tsx";
import { Reviewer } from "./Reviewer.tsx";
import { useSession } from "./useSession.ts";

export function App() {
  const { view, sendText, reset, fastForward } = useSession();
  const slots = (view.state?.slots ?? {}) as Record<
    string,
    { value: string | null; status: string }
  >;
  const agent = slots.agent_name;
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
        />
      </main>
      <Reviewer
        state={view.state}
        log={view.log}
        now={view.now}
        sessionId={view.sessionId}
        connected={view.connected}
        onFastForward={(ms) => void fastForward(ms)}
        onReset={() => void reset()}
      />
    </div>
  );
}

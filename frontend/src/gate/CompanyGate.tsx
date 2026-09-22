import { FormEvent, useState } from "react";
import { rememberCompanyVisit } from "../lib/visitBeacon";
import "./gate.css";

export function CompanyGate({ onUnlock }: { onUnlock: () => void }) {
  const [company, setCompany] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const name = company.trim();
    if (!name) {
      setError("Company name is required.");
      return;
    }
    rememberCompanyVisit(name);
    onUnlock();
  }

  return (
    <div className="room-gate">
      <form className="room-gate__sheet" onSubmit={submit}>
        <p className="room-gate__kicker">Room</p>
        <h1>Who is opening this.</h1>
        <p className="room-gate__hint">
          The documents stay behind the door until a company is named. The visit is filed with the desk.
        </p>
        <div className="field">
          <label htmlFor="company">Company</label>
          <input
            id="company"
            autoFocus
            autoComplete="organization"
            value={company}
            placeholder="Company name"
            onChange={(e) => {
              setCompany(e.target.value);
              setError(null);
            }}
          />
        </div>
        {error ? <p className="room-gate__error">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={!company.trim()}>
          Open the room
        </button>
      </form>
    </div>
  );
}

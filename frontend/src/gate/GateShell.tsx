import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { CompanyGate } from "./CompanyGate";
import { attachVisitTracker, isGateOpen, sendVisit } from "../lib/visitBeacon";

export function GateShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(isGateOpen);
  const location = useLocation();

  useEffect(() => {
    if (!open) return;
    return attachVisitTracker();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    sendVisit([
      { type: "page", path: location.pathname, detail: document.title.slice(0, 80) },
    ]);
  }, [open, location.pathname]);

  if (!open) return <CompanyGate onUnlock={() => setOpen(true)} />;
  return <>{children}</>;
}

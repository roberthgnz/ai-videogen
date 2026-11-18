"use client";

import { t as translate } from "@/lib/i18n";
import { useEffect, useRef, useState, useTransition } from "react";
import { Select, SelectItem } from "@/components/ui/select";
import type { RuleProposal, StyleProfile } from "@/lib/style-profile/schema";
import { acceptStyleRuleAction, discardStyleRuleAction, projectStyleAction } from "@/app/style/actions";
import { EditorIcon } from "./desktop-controls";
import "@/app/style/style.css";

const NEW = "__new";

/**
 * Rules the assistant proposes for «Mi estilo» after a correction, waiting in the chat for the user's answer:
 * add it (reworded if they like) or discard it. Nothing reaches a profile without that click. Read again
 * whenever the conversation moves (`refreshKey`), since the assistant leaves them during its turn.
 */
export function StyleRuleProposals({ projectId, refreshKey, disabled }: { projectId: string; refreshKey: number; disabled: boolean }) {
  const [proposals, setProposals] = useState<RuleProposal[]>([]);
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [assignedId, setAssignedId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const seen = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    projectStyleAction(projectId).then((s) => {
      if (!live) return;
      setProposals(s.proposals);
      setProfiles(s.profiles);
      setAssignedId(s.assignedId);
    }).catch(() => {});
    return () => { live = false; };
  }, [projectId, refreshKey]);

  // A new proposal arrives after the reply it belongs to: bring it into view once, gently.
  useEffect(() => {
    if (proposals.length > seen.current) root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    seen.current = proposals.length;
  }, [proposals.length]);

  if (!proposals.length && !done) return null;
  return <div ref={root} className="style-proposals">
    {proposals.map((p) => <ProposalCard key={p.id} projectId={projectId} proposal={p} profiles={profiles} assignedId={assignedId} disabled={disabled}
      onAnswered={(text, profile) => {
        setProposals((list) => list.filter((x) => x.id !== p.id));
        if (profile) {
          setProfiles((list) => (list.some((x) => x.id === profile.id) ? list.map((x) => (x.id === profile.id ? profile : x)) : [profile, ...list]));
          setAssignedId((current) => current ?? profile.id);
        }
        setDone(text);
      }} />)}
    {done && <div className="chat-notice" role="status"><p>{done}</p><button type="button" aria-label={translate("Close Warning")} onClick={() => setDone(null)}><EditorIcon name="close" /></button></div>}
  </div>;
}

function ProposalCard({ projectId, proposal, profiles, assignedId, disabled, onAnswered }: {
  projectId: string; proposal: RuleProposal; profiles: StyleProfile[]; assignedId: string | null; disabled: boolean;
  onAnswered: (text: string, profile?: StyleProfile) => void;
}) {
  const [text, setText] = useState(proposal.text);
  const [target, setTarget] = useState(assignedId ?? profiles[0]?.id ?? NEW);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<"add" | "discard" | null>(null);
  const assigned = profiles.find((p) => p.id === assignedId);
  const blocked = disabled || pending;

  function add() {
    setChoice("add");
    setError(null);
    start(async () => {
      const result = await acceptStyleRuleAction(projectId, proposal.id, { text, targetId: assigned ? undefined : target === NEW ? null : target })
        .catch(() => ({ ok: false as const, error: translate("The rule could not be added.") }));
      if (!result.ok) { setError(result.error); return; }
      onAnswered(translate("Added to \"{0}.\" The assistant will follow you in all projects that use that style; you can change it in My style.", result.profile.name), result.profile);
    });
  }
  function discard() {
    setChoice("discard");
    setError(null);
    start(async () => {
      const result = await discardStyleRuleAction(projectId, proposal.id).catch(() => ({ ok: false as const, error: translate("It couldn't be ruled out.") }));
      if (!result.ok) { setError(result.error); return; }
      onAnswered(translate("Disloaded. It only applies to this video if you ask."));
    });
  }
  const label = (mine: "add" | "discard", idle: string) => (pending && choice === mine ? translate("One moment…") : idle);

  return <section className="chat-card style-proposal-card" aria-label={translate("Proposed rule for My style")}>
    <header><EditorIcon name="sparkles" /><strong>{translate("Do I keep it in your style?")}</strong><span>{assigned ? `«${assigned.name}»` : translate("My style")}</span></header>
    <div className="chat-step-body style-proposal">
      <p>{translate("The assistant proposes to remember this for your next videos. You can change the text before adding it.")}</p>
      <textarea className="ui-field w-full rounded-[10px] px-3 py-2 leading-6" aria-label={translate("Proposed rule")} rows={2} maxLength={300} value={text} disabled={blocked} onChange={(e) => setText(e.target.value)} />
      {proposal.reason && <small>{proposal.reason}</small>}
      {!assigned && <label className="pro-label">{translate("Save in")}<Select aria-label={translate("Style where to save the rule")} value={target} disabled={blocked} onValueChange={setTarget}>
          {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          <SelectItem value={NEW}>{translate("A new style, \"My style.\"")}</SelectItem>
        </Select>
        <small>{translate("This project will go on to use that style.")}</small>
      </label>}
      <div className="chat-row">
        <button type="button" className="chat-secondary" disabled={blocked} onClick={discard}>{label("discard", translate("Discard"))}</button>
        <button type="button" className="chat-primary" disabled={blocked || text.trim().length < 3} onClick={add}>{label("add", translate("Add to my style"))}</button>
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
  </section>;
}

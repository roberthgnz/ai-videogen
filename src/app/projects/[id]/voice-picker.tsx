"use client";

import { t as translate } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Select, SelectGroup, SelectItem } from "@/components/ui/select";

interface VoiceOption {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string | null;
}

/** Radix Select items can't have "" as value: this stands for "no voice". */
const NONE = "__none__";

/** Voice selector backed by /api/voices (the TTS provider's list), with preview. */
export function VoicePicker({ id, value, onChange }: { id?: string; value: string | null; onChange: (id: string | null) => void }) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/voices${refresh ? "?refresh=1" : ""}`);
      const json = (await res.json()) as { voices?: VoiceOption[]; error?: string };
      if (!res.ok || !json.voices) throw new Error(json.error ?? `HTTP ${res.status}`);
      setVoices(json.voices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: setState happens after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const selected = voices?.find((v) => v.id === value);

  function preview() {
    if (!selected?.previewUrl) return;
    audioRef.current?.pause();
    audioRef.current = new Audio(selected.previewUrl);
    void audioRef.current.play();
  }

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-danger">{translate("The voices could not be loaded:")} {error}</p>
        <div className="flex gap-2">
          <Input id={id} value={value ?? ""} onValueChange={(value) => onChange(value.trim() || null)} placeholder={translate("or paste a voice ID")} className="font-mono" />
          <Button variant="outline" size="sm" className="h-9" onClick={() => load(true)}>{translate("Retry")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Select
        id={id}
        value={value ?? NONE}
        disabled={loading}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        placeholder={loading ? translate("Loading voices…") : translate("Choose a voice")}
      >
        <SelectItem value={NONE}>{loading ? translate("Loading voices…") : translate("No voiceover")}</SelectItem>
        {value && voices && !selected && <SelectItem value={value}>{value}{translate("(not on the list)")}</SelectItem>}
        {groupByCategory(voices ?? []).map(([category, group]) => (
          <SelectGroup key={category} label={category}>
            {group.map((v) => (
              <SelectItem key={v.id} value={v.id} hint={describe(v)}>
                {v.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </Select>
      <IconButton label={translate("Listen to a voice sample")} variant="outline" onClick={preview} disabled={!selected?.previewUrl}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" />
        </svg>
      </IconButton>
    </div>
  );
}

function describe(v: VoiceOption): string | undefined {
  const bits = [v.labels?.gender, v.labels?.accent, v.labels?.age, v.labels?.languages].filter(Boolean);
  return bits.length ? bits.join(", ") : undefined;
}

function groupByCategory(voices: VoiceOption[]): [string, VoiceOption[]][] {
  const groups = new Map<string, VoiceOption[]>();
  for (const v of voices) {
    const key = v.category ?? translate("Voices");
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.entries()];
}

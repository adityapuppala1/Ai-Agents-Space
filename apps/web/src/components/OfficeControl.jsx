import React from "react";
import { Radio, Palette, PlugZap, ArrowUpRight, Bot, Cpu, Clock3 } from "lucide-react";
import { activityLabel, formatElapsed, providerLabel } from "../hooks/useApi.js";

export const OFFICE_THEMES = [
  ["studio", "Daylight studio", "#adc8dc"],
  ["operations", "Mission control", "#324964"],
  ["garden", "Garden atelier", "#7eac8c"],
  ["midnight", "Midnight lab", "#8371bf"],
  ["sandstone", "Desert studio", "#c79a72"],
];

const quiet = new Set(["IDLE", "STALE"]);

export default function OfficeControl({ agents, visibleCount, filters, onFilters, theme, onTheme, isDemo, onConnections, onSelectAgent }) {
  const providers = [...new Set(agents.map(a => a.provider).filter(Boolean))];
  const roles = [...new Set(agents.map(a => a.role).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const active = agents.filter(a => a.activeProviderRun).length;
  const liveAgents = agents
    .filter(a => a.activeProviderRun || !quiet.has(a.activity))
    .sort((a,b) => Number(b.activeProviderRun) - Number(a.activeProviderRun))
    .slice(0, 6);
  return <section className="office-control" aria-label="Office controls">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="office-signal"><Radio size={18}/><div><strong>{isDemo ? "Explore the demo floor" : `${active} active provider run${active === 1 ? "" : "s"}`}</strong><p>{isDemo ? "Simulated team · connect an assistant to see real work." : "Activity follows recorded provider events. Tool-based interpretations are labeled inferred."}</p></div></div>
      <button className="office-connect" onClick={onConnections}><PlugZap size={15}/> Connect assistants <ArrowUpRight size={14}/></button>
    </div>
    <div className="office-scope flex flex-wrap items-center gap-2" aria-label="Filter office by provider">
      <span className="control-caption">PROVIDER</span>
      <button aria-pressed={!filters?.provider} onClick={() => onFilters({...filters, provider:null})}>All assistants <b>{agents.length}</b></button>
      {providers.map(provider => <button key={provider} aria-pressed={filters?.provider === provider} onClick={() => onFilters({...filters, provider:filters?.provider === provider ? null : provider})}>{providerLabel(provider)} <b>{agents.filter(a=>a.provider===provider).length}</b></button>)}
      <span className="office-visible">{visibleCount} visible</span>
    </div>
    {roles.length > 1 && <div className="office-roles flex flex-wrap items-center gap-2" aria-label="Filter office by role">
      <span className="control-caption">ROLE</span>
      <button aria-pressed={!filters?.role} onClick={() => onFilters({...filters, role:null})}>All roles <b>{roles.length}</b></button>
      {roles.map(role => <button key={role} aria-pressed={filters?.role === role} onClick={() => onFilters({...filters, role:filters?.role === role ? null : role})}>{role} <b>{agents.filter(a=>a.role===role).length}</b></button>)}
    </div>}
    <div className="office-environments flex flex-wrap items-center gap-2" aria-label="Office environments"><span className="control-caption"><Palette size={13}/> SPACE</span>
      {OFFICE_THEMES.map(([id,label,color]) => <button key={id} aria-pressed={theme===id} onClick={()=>onTheme(id)}><i style={{background:color}}/>{label}</button>)}
    </div>
    {liveAgents.length > 0 && <div className="activity-ribbon" aria-label="Live agent activity">
      <div className="activity-ribbon-heading"><span><span className="live-beacon"/> NOW ON THE FLOOR</span><small>{isDemo ? "Simulated preview" : "Recorded provider activity"}</small></div>
      <div className="activity-ribbon-track">
        {liveAgents.map(agent => <button key={agent.id} className="activity-ribbon-agent" onClick={()=>onSelectAgent?.(agent.id)} aria-label={`Inspect ${agent.name}: ${activityLabel(agent.activity)}`}>
          <span className="ribbon-avatar" style={{"--ribbon-color":agent.color}}><Bot size={15}/></span>
          <span className="ribbon-copy"><strong>{agent.name}<em>{activityLabel(agent.activity)}</em></strong><span>{agent.currentAction || agent.taskTitle || "No current action reported"}</span></span>
          <span className="ribbon-runtime"><b><Cpu size={11}/>{providerLabel(agent.provider)}</b>{agent.elapsedMs != null && <small><Clock3 size={10}/>{formatElapsed(agent.elapsedMs)}</small>}</span>
        </button>)}
      </div>
    </div>}
    {visibleCount === 0 && <p className="office-empty">No agents match these filters. Clear the filters or connect an assistant to populate this space.</p>}
  </section>;
}

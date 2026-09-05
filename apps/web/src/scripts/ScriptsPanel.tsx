import { useState } from "react";
import { text } from "../i18n";
import { useShellStore } from "../store";
import { useScriptsStore } from "./store";

/**
 * The Scripts panel: record, name, play, delete.
 *
 * Everything here goes through the four `script.*` commands rather than
 * calling the store directly, so that the panel, the menu and the palette all
 * do the same thing — the same reason the layer context menu asks the command
 * catalogue for its entries (stage 7).
 */
export function ScriptsPanel() {
  const language = useShellStore((state) => state.language);
  const { scripts, recording, recordedCount, lastRun } = useScriptsStore();
  const store = useScriptsStore();
  const [name, setName] = useState("");

  const stop = () => { store.stopRecording(name); setName(""); };

  return <div className="scripts-panel">
    <div className="scripts-record">
      {recording ? <>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={text(language, "Name this script…", "Название сценария…")}
          onKeyDown={(event) => { if (event.key === "Enter") stop(); }}
        />
        <button className="primary" onClick={stop}>
          {text(language, "Stop", "Стоп")} · {recordedCount}
        </button>
        <button onClick={store.cancelRecording}>{text(language, "Discard", "Отменить")}</button>
      </> : <button className="primary" onClick={store.startRecording}>● {text(language, "Record", "Запись")}</button>}
    </div>

    {recording && <p className="scripts-hint">{text(
      language,
      "Every command you run is being recorded. Undo, redo and the script commands themselves are not.",
      "Записывается каждая выполненная команда. Отмена, повтор и сами команды сценариев — нет.",
    )}</p>}

    <div className="scripts-list">
      {scripts.length === 0 && !recording && <p className="scripts-empty">{text(language, "No scripts recorded yet.", "Сценариев пока нет.")}</p>}
      {scripts.map((script) => {
        const run = lastRun?.scriptId === script.id ? lastRun : null;
        return <div className="scripts-row" key={script.id}>
          <button className="scripts-play" onClick={() => { void store.play(script.id); }} disabled={recording} title={text(language, "Play", "Воспроизвести")}>▶</button>
          <span className="scripts-name">
            <b>{script.name}</b>
            <small>{script.steps.length} {text(language, "step(s)", "шаг(ов)")}</small>
          </span>
          <button className="scripts-delete" onClick={() => store.remove(script.id)} title={text(language, "Delete", "Удалить")}>×</button>
          {run && <small className="scripts-result" data-failed={run.failure ? "" : undefined}>
            {run.failure
              // Naming the step and the command is the whole value of stopping
              // rather than skipping: the user gets told where it stopped.
              ? `${text(language, "Stopped at step", "Остановлено на шаге")} ${run.failure.step} — ${run.failure.commandId}`
              : `${text(language, "Ran", "Выполнено")} ${run.completed}`}
          </small>}
        </div>;
      })}
    </div>
  </div>;
}

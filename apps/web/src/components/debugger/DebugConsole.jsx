import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import clsx from "clsx";
import { sendConsoleCommand } from "../../redux/debugger/actions";
import { useTranslation } from "@zxplay/i18n";

// REPL over the zx_go debug command protocol. This surfaces the entire
// command set, including commands the panels don't wrap — and commands
// added upstream work here without any UI changes.
export function DebugConsole() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const history = useSelector((state) => state?.debugger.consoleHistory);
  const [text, setText] = useState("");
  const [recall, setRecall] = useState(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history]);

  const commands = history.filter((entry) => entry.kind === "cmd");

  const submit = () => {
    if (!text.trim()) return;
    dispatch(sendConsoleCommand(text));
    setText("");
    setRecall(null);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      submit();
    } else if (e.key === "ArrowUp" && commands.length > 0) {
      e.preventDefault();
      const index = recall === null ? commands.length - 1 : Math.max(0, recall - 1);
      setRecall(index);
      setText(commands[index].text);
    } else if (e.key === "ArrowDown" && recall !== null) {
      e.preventDefault();
      const index = recall + 1;
      if (index >= commands.length) {
        setRecall(null);
        setText("");
      } else {
        setRecall(index);
        setText(commands[index].text);
      }
    }
  };

  return (
    <div className="debug-console">
      <div className="debug-console-scroll" ref={scrollRef}>
        {history.map((entry, i) => (
          <div
            key={i}
            className={clsx("debug-console-line", entry.kind !== "cmd" && entry.kind)}
          >
            {entry.kind === "cmd" && <span className="prompt">›</span>}
            {entry.text}
          </div>
        ))}
      </div>
      <div
        className="debug-console-input"
        onClick={() => inputRef.current?.focus()}
      >
        <span className="prompt">›</span>
        <input
          ref={inputRef}
          value={text}
          placeholder={t("debug.consolePlaceholder")}
          onChange={(e) => {
            setText(e.target.value);
            setRecall(null);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

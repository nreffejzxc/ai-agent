/**
 * Embeddable chat widget.
 *
 * Drop this on any page with one tag:
 *
 *   <script src="https://your-server.com/widget.js"
 *           data-api="https://your-server.com"
 *           data-title="Northside Bike Works"
 *           data-greeting="Hi! Ask me about repairs, hours or pricing."
 *           data-accent="#1f6f4a"></script>
 *
 * Everything lives in a shadow root, so your site's CSS can't break the widget
 * and the widget can't leak styles onto your site.
 */
(function () {
  "use strict";

  var script =
    document.currentScript || document.querySelector("script[data-api]");

  var config = {
    api: read("api", window.location.origin).replace(/\/+$/, ""),
    title: read("title", "Chat with us"),
    greeting: read("greeting", "Hi there — ask me anything and I'll help if I can."),
    accent: read("accent", "#1f6f4a"),
    launcherLabel: read("launcher", "Chat with us"),
  };

  function read(name, fallback) {
    var value = script && script.dataset ? script.dataset[name] : null;
    return value && value.trim() ? value.trim() : fallback;
  }

  var STORE_KEY = "support-agent:v1";
  var state = { sessionId: null, messages: [], busy: false, open: false };

  restore();

  // --- markup -------------------------------------------------------------

  var host = document.createElement("div");
  host.setAttribute("data-support-agent", "");
  document.body.appendChild(host);

  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" + styles() + "</style>" +
    '<div class="wrap">' +
      '<section class="panel" part="panel" hidden>' +
        '<header>' +
          '<span class="title"></span>' +
          '<button class="close" type="button" aria-label="Close chat">' + closeIcon() + "</button>" +
        "</header>" +
        '<div class="log" role="log" aria-live="polite" aria-relevant="additions text"></div>' +
        '<form class="composer">' +
          '<textarea rows="1" maxlength="2000" aria-label="Your message" placeholder="Type your message..."></textarea>' +
          '<button class="send" type="submit" aria-label="Send message">' + sendIcon() + "</button>" +
        "</form>" +
        '<p class="footnote">AI assistant &mdash; it can make mistakes. For anything important, please contact us directly.</p>' +
      "</section>" +
      '<button class="launcher" type="button" aria-expanded="false">' +
        chatIcon() + '<span class="launcher-text"></span>' +
      "</button>" +
    "</div>";

  var panel = root.querySelector(".panel");
  var launcher = root.querySelector(".launcher");
  var log = root.querySelector(".log");
  var form = root.querySelector(".composer");
  var input = root.querySelector("textarea");
  var sendButton = root.querySelector(".send");

  root.querySelector(".title").textContent = config.title;
  root.querySelector(".launcher-text").textContent = config.launcherLabel;
  host.style.setProperty("--accent", config.accent);

  // --- behaviour ----------------------------------------------------------

  launcher.addEventListener("click", function () {
    state.open ? closePanel() : openPanel();
  });
  root.querySelector(".close").addEventListener("click", closePanel);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.open) closePanel();
  });

  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    send(input.value);
  });

  function openPanel() {
    state.open = true;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    if (state.messages.length === 0) {
      addMessage("assistant", config.greeting);
      persist();
    }
    input.focus();
    scrollToEnd();
  }

  function closePanel() {
    state.open = false;
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
  }

  function send(raw) {
    var text = (raw || "").trim();
    if (!text || state.busy) return;

    input.value = "";
    input.style.height = "auto";
    setBusy(true);

    addMessage("user", text);
    persist();

    var bubble = addMessage("assistant", "");
    bubble.classList.add("pending");
    var typing = document.createElement("span");
    typing.className = "typing";
    typing.innerHTML = "<i></i><i></i><i></i>";
    bubble.appendChild(typing);

    var received = "";

    streamChat(
      text,
      function onDelta(chunk) {
        if (!received) {
          bubble.classList.remove("pending");
          bubble.textContent = "";
        }
        received += chunk;
        bubble.textContent = received;
        scrollToEnd();
      }
    )
      .then(function () {
        if (!received) {
          bubble.classList.remove("pending");
          bubble.textContent = "I didn't catch that — could you try again?";
          received = bubble.textContent;
        }
        state.messages[state.messages.length - 1].text = received;
        persist();
      })
      .catch(function (error) {
        bubble.classList.remove("pending");
        bubble.classList.add("failed");
        bubble.textContent =
          (error && error.message) ||
          "Sorry, I couldn't reach the assistant. Please try again.";
        // A failed turn isn't part of the conversation.
        state.messages.pop();
        persist();
      })
      .then(function () {
        setBusy(false);
        scrollToEnd();
        if (state.open) input.focus();
      });
  }

  async function streamChat(text, onDelta) {
    var response = await fetch(config.api + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
    });

    if (!response.ok || !response.body) {
      var message = "Sorry, I couldn't reach the assistant. Please try again.";
      try {
        var payload = await response.json();
        if (payload && payload.error) message = payload.error;
      } catch (ignored) {
        /* response wasn't JSON — keep the generic message */
      }
      throw new Error(message);
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    while (true) {
      var step = await reader.read();
      if (step.done) break;

      buffer += decoder.decode(step.value, { stream: true });

      // Server-sent events are separated by a blank line. The last piece may
      // be a partial event, so hold it back until more bytes arrive.
      var events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (var i = 0; i < events.length; i++) {
        var line = events[i].split("\n").find(function (candidate) {
          return candidate.indexOf("data:") === 0;
        });
        if (!line) continue;

        var event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (ignored) {
          continue;
        }

        if (event.type === "session") {
          state.sessionId = event.sessionId;
          persist();
        } else if (event.type === "delta") {
          onDelta(event.text);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }
  }

  function addMessage(role, text) {
    var bubble = document.createElement("div");
    bubble.className = "msg " + role;
    bubble.textContent = text;
    log.appendChild(bubble);
    state.messages.push({ role: role, text: text });
    scrollToEnd();
    return bubble;
  }

  function setBusy(busy) {
    state.busy = busy;
    input.disabled = busy;
    sendButton.disabled = busy;
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function persist() {
    try {
      sessionStorage.setItem(
        STORE_KEY,
        JSON.stringify({ sessionId: state.sessionId, messages: state.messages })
      );
    } catch (ignored) {
      /* private browsing or storage full — the chat still works, it just
         won't survive a page navigation */
    }
  }

  function restore() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (saved && Array.isArray(saved.messages)) {
        state.sessionId = saved.sessionId || null;
        state.messages = saved.messages;
      }
    } catch (ignored) {
      /* ignore corrupt storage */
    }
  }

  // Repaint any conversation carried over from a previous page.
  state.messages.forEach(function (message) {
    var bubble = document.createElement("div");
    bubble.className = "msg " + message.role;
    bubble.textContent = message.text;
    log.appendChild(bubble);
  });

  // --- presentation -------------------------------------------------------

  function styles() {
    return [
      ":host { --accent: #1f6f4a; --bg: #ffffff; --fg: #16181c; --muted: #6b7280;",
      "  --line: #e6e8ec; --bubble: #f2f4f7; all: initial; }",
      "* { box-sizing: border-box; margin: 0; padding: 0;",
      "  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }",
      ".wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;",
      "  display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }",

      ".launcher { display: inline-flex; align-items: center; gap: 8px;",
      "  border: 0; border-radius: 999px; padding: 13px 20px; cursor: pointer;",
      "  background: var(--accent); color: #fff; font-size: 15px; font-weight: 550;",
      "  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.22); transition: transform .15s ease; }",
      ".launcher:hover { transform: translateY(-1px); }",
      ".launcher svg { width: 19px; height: 19px; }",

      ".panel { width: 380px; height: 560px; max-height: calc(100vh - 120px);",
      "  display: flex; flex-direction: column; overflow: hidden;",
      "  background: var(--bg); color: var(--fg); border: 1px solid var(--line);",
      "  border-radius: 16px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.24); }",
      ".panel[hidden] { display: none; }",

      "header { display: flex; align-items: center; justify-content: space-between;",
      "  gap: 12px; padding: 14px 16px; background: var(--accent); color: #fff; }",
      ".title { font-size: 15px; font-weight: 600; }",
      ".close { border: 0; background: transparent; color: #fff; cursor: pointer;",
      "  opacity: .8; display: flex; padding: 4px; border-radius: 6px; }",
      ".close:hover { opacity: 1; background: rgba(255,255,255,.15); }",
      ".close svg { width: 15px; height: 15px; }",

      ".log { flex: 1; overflow-y: auto; padding: 16px; display: flex;",
      "  flex-direction: column; gap: 10px; }",
      ".msg { max-width: 84%; padding: 10px 13px; border-radius: 14px;",
      "  font-size: 14.5px; line-height: 1.5; white-space: pre-wrap;",
      "  overflow-wrap: anywhere; }",
      ".msg.assistant { align-self: flex-start; background: var(--bubble);",
      "  border-bottom-left-radius: 5px; }",
      ".msg.user { align-self: flex-end; background: var(--accent); color: #fff;",
      "  border-bottom-right-radius: 5px; }",
      ".msg.failed { background: #fdecec; color: #8f2323; }",

      ".typing { display: inline-flex; gap: 4px; padding: 3px 0; }",
      ".typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted);",
      "  animation: blink 1.3s infinite ease-in-out; }",
      ".typing i:nth-child(2) { animation-delay: .18s; }",
      ".typing i:nth-child(3) { animation-delay: .36s; }",
      "@keyframes blink { 0%, 60%, 100% { opacity: .25 } 30% { opacity: 1 } }",

      ".composer { display: flex; align-items: flex-end; gap: 8px;",
      "  padding: 10px 12px; border-top: 1px solid var(--line); }",
      "textarea { flex: 1; resize: none; border: 1px solid var(--line);",
      "  border-radius: 10px; padding: 9px 11px; font-size: 14.5px; line-height: 1.45;",
      "  max-height: 120px; background: var(--bg); color: var(--fg); }",
      "textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }",
      "textarea:disabled { opacity: .6; }",
      ".send { flex: 0 0 auto; border: 0; border-radius: 10px; cursor: pointer;",
      "  width: 38px; height: 38px; display: grid; place-items: center;",
      "  background: var(--accent); color: #fff; }",
      ".send:disabled { opacity: .45; cursor: default; }",
      ".send svg { width: 17px; height: 17px; }",

      ".footnote { padding: 0 14px 11px; font-size: 11.5px; line-height: 1.4;",
      "  color: var(--muted); text-align: center; }",

      "@media (prefers-color-scheme: dark) {",
      "  :host { --bg: #16181c; --fg: #eceef1; --muted: #9aa2ae;",
      "    --line: #2b2f36; --bubble: #23272e; }",
      "  .msg.failed { background: #3a1f1f; color: #ffb4b4; }",
      "}",

      "@media (max-width: 480px) {",
      "  .wrap { right: 12px; bottom: 12px; left: 12px; align-items: stretch; }",
      "  .panel { width: auto; height: min(72vh, 560px); }",
      "  .launcher { align-self: flex-end; }",
      "}",

      "@media (prefers-reduced-motion: reduce) {",
      "  .launcher, .typing i { transition: none; animation: none; }",
      "}",
    ].join("\n");
  }

  function chatIcon() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/>' +
      "</svg>"
    );
  }

  function closeIcon() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    );
  }

  function sendIcon() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 19V5M5 12l7-7 7 7"/></svg>'
    );
  }
})();

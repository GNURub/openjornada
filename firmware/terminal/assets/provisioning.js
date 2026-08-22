(() => {
  "use strict";

  const HASH_PREFIX = "#ojp=";
  const PORTAL_URL = "http://192.168.4.1/";
  const ERROR =
    "No se pudo leer la configuración del QR. Introduce los datos manualmente.";
  const REVIEW =
    "Configuración leída. Revisa los datos y pulsa Comprobar y guardar.";
  const encoder = new TextEncoder();
  const installedToggles = new WeakSet();
  const installedPasswordFields = new WeakSet();

  function bytes(value) {
    return encoder.encode(value).byteLength;
  }

  function visibleAscii(value) {
    return Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code >= 0x21 && code <= 0x7e;
    });
  }

  function forbiddenText(value) {
    return value.includes("\0") || value.includes("\r") || value.includes("\n");
  }

  function encodeBase64Url(value) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
  }

  function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
      throw new Error("invalid");
    }

    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const decoded = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64Url(decoded) !== value) throw new Error("invalid");
    return decoded;
  }

  function sameBytes(left, right) {
    return (
      left.byteLength === right.byteLength &&
      left.every((value, index) => value === right[index])
    );
  }

  function validUrl(value) {
    if (
      !visibleAscii(value) ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#")
    ) {
      return false;
    }

    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname.length > 0 &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }

  function decodeProvisioningHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith(HASH_PREFIX)) return null;
    if (bytes(`${PORTAL_URL}${hash}`) > 600) throw new Error("invalid");

    const payload = hash.slice(HASH_PREFIX.length);
    const rawBytes = decodeBase64Url(payload);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    const value = JSON.parse(json);

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid");
    }
    if (Object.keys(value).join(",") !== "v,s,p,u,t") {
      throw new Error("invalid");
    }
    if (
      value.v !== 1 ||
      typeof value.s !== "string" ||
      typeof value.p !== "string" ||
      typeof value.u !== "string" ||
      typeof value.t !== "string"
    ) {
      throw new Error("invalid");
    }

    const canonical = JSON.stringify({
      v: 1,
      s: value.s,
      p: value.p,
      u: value.u,
      t: value.t,
    });
    if (!sameBytes(rawBytes, encoder.encode(canonical))) {
      throw new Error("invalid");
    }
    if (
      value.s.length === 0 ||
      bytes(value.s) > 32 ||
      bytes(value.p) > 63 ||
      value.u.length === 0 ||
      bytes(value.u) > 255 ||
      value.t.length <= 7 ||
      bytes(value.t) > 96 ||
      [value.s, value.p, value.u, value.t].some(forbiddenText) ||
      !validUrl(value.u) ||
      !visibleAscii(value.t) ||
      !value.t.startsWith("ojterm_")
    ) {
      throw new Error("invalid");
    }

    return {
      ssid: value.s,
      wifiPassword: value.p,
      baseUrl: value.u,
      terminalToken: value.t,
    };
  }

  function setStatus(message, error) {
    const status = document.getElementById("qr_status");
    if (!status) return;
    status.setAttribute("role", error ? "alert" : "status");
    status.setAttribute("aria-live", error ? "assertive" : "polite");
    status.className = error ? "error" : "success";
    status.textContent = message;
    status.hidden = false;
  }

  function applyHash() {
    if (!location.hash.startsWith(HASH_PREFIX)) return;

    try {
      const decoded = decodeProvisioningHash(location.hash);
      if (!decoded) return;
      const fields = [
        "ssid",
        "wifi_password",
        "wifi_password_explicit",
        "base_url",
        "terminal_token",
      ].map((id) => document.getElementById(id));
      if (fields.some((field) => !(field instanceof HTMLInputElement))) {
        throw new Error("invalid");
      }

      fields[0].value = decoded.ssid;
      fields[1].value = decoded.wifiPassword;
      fields[2].value = "1";
      fields[3].value = decoded.baseUrl;
      fields[4].value = decoded.terminalToken;
      setStatus(REVIEW, false);
    } catch {
      setStatus(ERROR, true);
    } finally {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }

  function installToggle(buttonId, shownLabel, hiddenLabel) {
    const button = document.getElementById(buttonId);
    if (
      !(button instanceof HTMLButtonElement) ||
      installedToggles.has(button)
    ) {
      return;
    }
    const field = document.getElementById(button.dataset.target || "");
    if (!(field instanceof HTMLInputElement)) return;

    button.type = "button";
    button.setAttribute("aria-pressed", String(field.type !== "password"));
    button.setAttribute(
      "aria-label",
      field.type === "password" ? shownLabel : hiddenLabel,
    );
    button.addEventListener("click", () => {
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", String(show));
      button.setAttribute("aria-label", show ? hiddenLabel : shownLabel);
    });
    installedToggles.add(button);
  }

  function installPasswordExplicitReset() {
    const password = document.getElementById("wifi_password");
    const explicit = document.getElementById("wifi_password_explicit");
    if (
      !(password instanceof HTMLInputElement) ||
      !(explicit instanceof HTMLInputElement) ||
      installedPasswordFields.has(password)
    ) {
      return;
    }
    password.addEventListener("input", () => {
      explicit.value = "0";
    });
    installedPasswordFields.add(password);
  }

  function init() {
    installToggle(
      "toggle_wifi_password",
      "Mostrar contraseña Wi-Fi",
      "Ocultar contraseña Wi-Fi",
    );
    installToggle(
      "toggle_terminal_token",
      "Mostrar API key del terminal",
      "Ocultar API key del terminal",
    );
    installPasswordExplicitReset();
    applyHash();
  }

  window.OpenJornadaProvisioning = Object.freeze({
    decodeProvisioningHash,
    init,
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

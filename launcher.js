if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {});
}

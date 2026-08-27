export function notice(req, message) {
  req.session.flash = { type: "notice", message };
}

export function alert(req, message) {
  req.session.flash = { type: "alert", message };
}

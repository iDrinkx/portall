module.exports = (req, res, next) => {
  if (!req.session || !req.session.plexUser) {
    console.log("⛔ Not authenticated");
    return res.redirect("/");
  }

  next();
};
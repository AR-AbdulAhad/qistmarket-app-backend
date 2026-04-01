const getPKTDate = () => {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 * 60 * 1000));
};

module.exports = {
  getPKTDate
};

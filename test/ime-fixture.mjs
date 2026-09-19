// Public test pixels only; no real candidate text is stored in tests.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
console.log(
  JSON.stringify({
    visible: true,
    x: 400,
    y: 900,
    width: 400,
    height: 100,
    frameWidth: 1669,
    frameHeight: 1147,
    png,
  }),
);
setInterval(() => console.log('{"heartbeat":true}'), 2000);

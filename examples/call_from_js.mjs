// Call YOUR API from JavaScript — the API uses the duck.ai Luna model for you.
const r = await fetch("http://localhost:3000/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "hi", model: "Luna" }),
});
console.log(await r.json());
// { model: "Luna", reply: "...", mode: "browser" }

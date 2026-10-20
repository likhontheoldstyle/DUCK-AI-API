# Call YOUR API from Python — the API uses the duck.ai Luna model for you.
import requests

r = requests.post("http://localhost:3000/chat",
                  json={"message": "hi", "model": "Luna"})
print(r.json())
# {"model": "Luna", "reply": "...", "mode": "browser"}

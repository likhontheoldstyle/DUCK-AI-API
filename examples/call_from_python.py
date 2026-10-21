import requests

r = requests.post("http://localhost:3000/chat",
                  json={"message": "hi", "model": "Luna"})
print(r.json())

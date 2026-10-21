from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="not-needed")

print([m.id for m in client.models.list().data])

resp = client.chat.completions.create(
    model="gpt-6-luna",  # or "Luna", "gpt-5.6-terra", "claude-sonnet-4-6", ...
    messages=[{"role": "user", "content": "hi"}],
)
print(resp.choices[0].message.content)

img = client.images.generate(model="gpt-6-luna", prompt="a cat astronaut in space")
print([d.url for d in img.data])

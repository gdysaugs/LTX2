import json
from pathlib import Path

src = Path('/mnt/c/Users/adama/Downloads/rapid-aio-mega-gguf-example.json')
dst = Path('/home/adama/src/camcam2/functions/api/wan-workflow.json')

with src.open('r', encoding='utf-8') as f:
    data = json.load(f)

nodes = data['nodes']
links = {l[0]: l for l in data['links']}

prompt = {}

for node in nodes:
    nid = str(node['id'])
    entry = {
        'class_type': node.get('type'),
        'inputs': {}
    }
    inputs = node.get('inputs', [])
    widgets = node.get('widgets_values')
    widget_idx = 0

    # custom handling for KSampler widgets (seed_mode extra)
    mapping = None
    if node.get('type') == 'KSampler' and isinstance(widgets, list):
        mapping = {
            'seed': widgets[0] if len(widgets) > 0 else 0,
            'steps': widgets[2] if len(widgets) > 2 else 4,
            'cfg': widgets[3] if len(widgets) > 3 else 5,
            'sampler_name': widgets[4] if len(widgets) > 4 else 'euler',
            'scheduler': widgets[5] if len(widgets) > 5 else 'beta',
            'denoise': widgets[6] if len(widgets) > 6 else 1,
        }

    for inp in inputs:
        name = inp['name']
        if inp.get('link') is not None:
            link = links[inp['link']]
            src_id = str(link[1])
            src_slot = link[2]
            entry['inputs'][name] = [src_id, src_slot]
            if inp.get('widget') and isinstance(widgets, list):
                widget_idx += 1
            continue

        if inp.get('widget'):
            if mapping and name in mapping:
                entry['inputs'][name] = mapping[name]
            elif isinstance(widgets, dict):
                if name in widgets:
                    entry['inputs'][name] = widgets[name]
            elif isinstance(widgets, list):
                if widget_idx < len(widgets):
                    entry['inputs'][name] = widgets[widget_idx]
                widget_idx += 1

    prompt[nid] = entry

# Update model filename for UnetLoaderGGUF
for nid, node in prompt.items():
    if node.get('class_type') == 'UnetLoaderGGUF':
        if 'unet_name' in node['inputs']:
            node['inputs']['unet_name'] = 'wan2.2-rapid-mega-aio-nsfw-v12.1-Q8_0.gguf'

# Add negative CLIPTextEncode node to support negative prompt
max_id = max(int(n['id']) for n in nodes)
neg_id = str(max_id + 1)

clip_loader_id = None
for nid, node in prompt.items():
    if node.get('class_type') == 'CLIPLoader':
        clip_loader_id = nid
        break

if clip_loader_id:
    prompt[neg_id] = {
        'class_type': 'CLIPTextEncode',
        'inputs': {
            'clip': [clip_loader_id, 0],
            'text': ''
        }
    }

# Helper to set link on input

def set_link(node_id, input_name, src_id, src_slot=0):
    node = prompt.get(str(node_id))
    if not node:
        return
    node.setdefault('inputs', {})[input_name] = [str(src_id), src_slot]

# Explicit wiring to avoid reliance on "Everywhere" nodes
# Model from ModelSamplingSD3 (32) -> KSampler model
for ks in ('8','55'):
    set_link(ks, 'model', '32', 0)

# VAE from VAELoader (53) -> WanVaceToVideo + VAEDecode
for vace in ('28','54'):
    set_link(vace, 'vae', '53', 0)

for vd in ('11','56'):
    set_link(vd, 'vae', '53', 0)

# Positive/negative conditioning
set_link('28', 'positive', '9', 0)
set_link('54', 'positive', '9', 0)
set_link('28', 'negative', neg_id, 0)
set_link('54', 'negative', neg_id, 0)

# Save
with dst.open('w', encoding='utf-8') as f:
    json.dump(prompt, f, ensure_ascii=False, indent=2)

print('Wrote', dst)
print('Negative prompt node id', neg_id)

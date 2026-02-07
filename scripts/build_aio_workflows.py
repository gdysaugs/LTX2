import json
from pathlib import Path

src = Path('/home/adama/src/camcam2/functions/api/wan-workflow.json')
with src.open('r', encoding='utf-8') as f:
    prompt = json.load(f)

i2v_ids = {"9","16","37","34","54","55","56","57","32","53","72","79","96"}
t2v_ids = {"9","28","8","11","39","32","53","72","79","96"}


def build(subset, out_path):
    out = {nid: node for nid, node in prompt.items() if nid in subset}
    for nid, node in out.items():
        inputs = node.get('inputs', {})
        clean = {}
        for key, val in inputs.items():
            if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                if val[0] in subset:
                    clean[key] = val
            else:
                clean[key] = val
        node['inputs'] = clean
    with out_path.open('w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Wrote', out_path)

build(i2v_ids, Path('/home/adama/src/camcam2/functions/api/wan-workflow-i2v.json'))
build(t2v_ids, Path('/home/adama/src/camcam2/functions/api/wan-workflow-t2v.json'))

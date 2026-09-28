from pathlib import Path
from PIL import Image, ImageDraw
import json

root=Path(__file__).resolve().parents[2]/'artifacts/four-horizons'
biomes=['verdant-airfield','azure-port','alpine-lake','sunstone-oasis']
views=['aerial','reverse','hero','topdown','street','shore','hero-reverse','transition','village']
for biome in biomes:
    directory=root/biome
    sheet=Image.new('RGB',(1440,936),'#15232b')
    draw=ImageDraw.Draw(sheet)
    validated=json.loads((directory/'source_validation.json').read_text(encoding='utf-8'))
    sources={Path(item).stem.split('-',2)[2]:directory/item for item in validated['renders']}
    for i,view in enumerate(views):
        x,y=(i%3)*480,(i//3)*312
        sheet.paste(Image.open(sources[view]).resize((480,300)),(x,y))
        draw.rectangle((x,y,x+160,y+24),fill='#15232b')
        draw.text((x+8,y+6),view,fill='white')
    sheet.save(directory/'contact-sheet.png')
sheet=Image.new('RGB',(1600,1020),'#15232b');draw=ImageDraw.Draw(sheet)
runtime=json.loads((root/'viewer/runtime_validation.json').read_text(encoding='utf-8')) if (root/'viewer/runtime_validation.json').exists() else {}
runtime_inputs={item['id']:item for item in runtime.get('inputEvidence',{}).get('inputs',[])}
for i,biome in enumerate(biomes):
    x,y=(i%2)*800,(i//2)*510
    source=root/'viewer'/f'{biome}.png'
    current_source=json.loads((root/biome/'asset_registry.json').read_text(encoding='utf-8'))['source']
    if not source.exists() or runtime_inputs.get(biome,{}).get('source')!=current_source:
        validated=json.loads((root/biome/'source_validation.json').read_text(encoding='utf-8'))
        source=root/biome/next(item for item in validated['renders'] if item.endswith('-aerial.png'))
    sheet.paste(Image.open(source).resize((800,500)),(x,y))
    draw.rectangle((x,y,x+250,y+30),fill='#15232b');draw.text((x+12,y+9),biome.replace('-',' ').title(),fill='white')
sheet.save(root/'Four_Horizons_preview.png')
sheet=Image.new('RGB',(1600,1040),'#15232b');draw=ImageDraw.Draw(sheet)
for i,biome in enumerate(biomes):
    x,y=(i%2)*800,(i//2)*520
    validated=json.loads((root/biome/'source_validation.json').read_text(encoding='utf-8'))
    source=root/biome/next(item for item in validated['renders'] if item.endswith('-human-network.png'))
    sheet.paste(Image.open(source).resize((800,500)),(x,y+20))
    draw.text((x+12,y+5),biome.replace('-',' ').title()+' | Connected settlements and land use',fill='white')
sheet.save(root/'Connected_landscapes_preview.png')

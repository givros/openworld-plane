"""Human-scale settlements and canopy-continuous landscapes for Four Horizons.

All dimensions are metres in the runtime X/Z horizontal frame. Layout precedes
construction: street edges, entries and occupied building envelopes are shared
with vegetation exclusion and semantic evidence.
"""
import math
import random
from layout_datums import entry_anchor


def distance_segment(x, z, a, b):
    dx, dz = b[0]-a[0], b[1]-a[1]
    length = dx*dx+dz*dz
    t = max(0, min(1, ((x-a[0])*dx+(z-a[1])*dz)/length)) if length else 0
    return math.hypot(x-a[0]-t*dx, z-a[1]-t*dz)


def planting(ctx, name, x, z, kind='mixed', width=3, depth=1.5, seed=0):
    # Geometry-free semantic replay records placement separately from prototypes.
    if not hasattr(ctx, 'meshes'):
        return
    from detailed_vegetation import plant_bed
    plant_bed(ctx, name, x, z, width, depth, kind=kind, spacing=.68, seed=seed)


def woodland(ctx, name, bounds, allowed, spacing=12, seed=1, styles=('oak',), height=(17,25)):
    """Jittered canopy grid; no count budget or stochastic holes in mature woods."""
    rng=random.Random(seed);records=[]
    x0,x1,z0,z1=bounds
    row=0; z=z0+spacing*.5
    while z<z1:
        x=x0+spacing*.5+(row%2)*spacing*.5
        while x<x1:
            px=x+rng.uniform(-spacing*.20,spacing*.20)
            pz=z+rng.uniform(-spacing*.20,spacing*.20)
            h=rng.uniform(*height)
            if allowed(px,pz,h):
                index=len(records);style=styles[index%len(styles)]
                ctx.tree(f'{name}/tree-{index:05}',px,pz,h,style)
                records.append({'center':[px,pz],'height':h,'style':style})
                if index%4==0:
                    planting(ctx,f'{name}/understory-{index:05}',px+2.1,pz-1.7,
                             kind='fern' if style=='pine' else 'mixed',width=3.8,depth=2.8,seed=seed+index)
            x+=spacing
        z+=spacing;row+=1
    return records


def rural_village(ctx, bench, fence):
    rng=random.Random(7139)
    streets=[('VillageLane',[(-370,-157),(-370,139)],6),
             ('CrossLane',[(-423,32),(-238,32)],5),
             ('MillLane',[(-370,139),(-392,230),(-420,350)],4),
             ('AirfieldLane',[(-370,-157),(-269,-192),(-191,-192)],5)]
    ctx.collection('MEADOW_COMPACT_VILLAGE')
    for name,pts,w in streets:
        ctx.path(name+'/shoulder',pts,w+1.3,'stone',lift=.055)
        ctx.path(name+'/gravel',pts,w,'gravel',lift=.09)
    plots=[]
    for side in (-1,1):
        for row,z in enumerate((-127,-105,-82,-59,-35,-12,62,85,109)):
            x=-370+side*(13.3+(row%3)*.55)
            width=rng.uniform(9.2,12.2);depth=rng.uniform(8.0,9.8)
            h=(6.3,6.6,3.35,6.45)[row%4];yaw=math.pi/2 if side<0 else -math.pi/2
            name=f'Meadow_Cottage_{side}_{row:02}'
            ctx.building(name,x,z,width,depth,h,('plaster_ivory','stone','plaster_ochre')[row%3],
                         'roof_slate' if row%5==0 else 'roof_terracotta',yaw,'farmhouse')
            entry,entry_z=entry_anchor(x,z,width,depth,yaw)
            ctx.path(name+'/entry',[(entry,entry_z),(-370+side*3,entry_z)],1.8,'gravel',lift=.11)
            plots.append({'id':name,'center':[x,z],'half':[depth/2+2.2,width/2+2.0],
                          'frontage':'VillageLane','entry':[entry,entry_z]})
            backx=x+side*(depth/2+5.1)
            fence(ctx,name+'/garden-fence',[(backx-side*4,z-width/2-2),(backx+side*4,z-width/2-2),
                   (backx+side*4,z+width/2+2),(backx-side*4,z+width/2+2)],1.05,2.5)
            planting(ctx,name+'/door-border',entry,z+2.5,'rose',1.2,2.2,100+row)
            planting(ctx,name+'/herb-garden',backx,z,'lavender',4.5,5.0,200+row)
            if row%2==0:
                ctx.tree(name+'/garden-apple',backx+side*3,z+3,7.5+row*.17,'oak')
    # A real village square and sideways-facing civic frontage break the rows.
    ctx.path('Meadow_VillageSquare',[(-411,23),(-411,43)],30,'stone',lift=.09)
    ctx.building('Meadow_Village_Inn',-434,32,15,10,9.1,'plaster_ivory','roof_terracotta',math.pi/2,'merchant')
    ctx.building('Meadow_Village_Bakery',-416,7,10.2,8.8,6.25,'plaster_ochre','roof_terracotta',0,'farmhouse')
    ctx.building('Meadow_Village_Cooperative',-418,61,13.4,9.8,6.4,'stone','roof_slate',math.pi,'farmhouse')
    for name,x,z,w,d,yaw,edge in [
        ('Meadow_Village_Inn',-434,32,15,10,math.pi/2,[-426,32]),
        ('Meadow_Village_Bakery',-416,7,10.2,8.8,0,[-417.1625,23]),
        ('Meadow_Village_Cooperative',-418,61,13.4,9.8,math.pi,[-418,43])]:
        ctx.path(name+'/entry',[entry_anchor(x,z,w,d,yaw),edge],1.8,'gravel',lift=.12)
    for x,z,w,d in [(-434,32,10,15),(-416,7,10.2,8.8),(-418,61,13.4,9.8)]:
        plots.append({'center':[x,z],'half':[w/2+2,d/2+2]})
    for i,(x,z) in enumerate(((-423,26),(-400,39),(-400,27))):
        bench(ctx,f'Meadow_Square_Bench{i}',x,z,yaw=math.pi/2)
    for i,(x,z) in enumerate(((-422,42),(-400,20))):
        ctx.tree(f'Meadow_Square_Linden{i}',x,z,12,'oak')
        planting(ctx,f'Meadow_Square_Flowers{i}',x,z,'mixed',3.2,3.2,370+i)
    return streets,plots


def rural_landscape(ctx, streets, plots, fence):
    rng=random.Random(10742)
    fields=[(-609,-538,211,194),(-585,-276,206,214),(-606,46,180,254),
            (-580,416,190,209),(428,-554,205,185),(501,475,252,196)]
    ctx.collection('MEADOW_CULTIVATED_PARCELS')
    for i,(cx,cz,w,d) in enumerate(fields):
        mat=('crop_gold','meadow_crop_green','meadow_field_soil')[i%3]
        nx,nz=math.ceil(w/5),math.ceil(d/5)
        vertices=[]
        for iz in range(nz+1):
            for ix in range(nx+1):
                x,z=cx-w/2+ix*w/nx,cz-d/2+iz*d/nz
                vertices.append((x,ctx.ground(x,z)+.085,z))
        faces=[]
        for iz in range(nz):
            for ix in range(nx):
                k=iz*(nx+1)+ix;faces.extend([(k,k+nx+1,k+1),(k+1,k+nx+1,k+nx+2)])
        ctx.mesh(f'Meadow_Field{i:02}_Surface',vertices,faces,mat)
        if hasattr(ctx,'meshes'):
            from ground_detail import crops
            crops(ctx,f'Meadow_Field{i:02}',cx,cz,w,d,'crop_gold' if i%3==0 else 'meadow_crop_green')
        for col in range(int(w/3)):
            x=cx-w/2+col*3+1.5
            ctx.path(f'Meadow_Field{i:02}_Furrow{col}',[(x,cz-d/2+1),(x,cz+d/2-1)],.32,'meadow_field_soil',lift=.105)
        fence(ctx,f'Meadow_Field{i:02}_Fence',[(cx-w/2,cz-d/2),(cx-w/2,cz+d/2),
              (cx+w/2,cz+d/2)],1.25,5)
        for n in range(int(d/8)):
            x,z=cx-w/2-5,cz-d/2+n*8
            ctx.tree(f'Meadow_Field{i:02}_Hedgerow{n}',x,z,rng.uniform(8,11),'oak')
        # Grounded hay assemblies supply productive scale without generic scatter.
        if i%3==0:
            for n in range(14):
                x,z=cx+rng.uniform(-w*.4,w*.4),cz+rng.uniform(-d*.4,d*.4)
                ctx.cyl(f'Meadow_Field{i:02}_Hay{n}',x,ctx.ground(x,z)+.9,z,1.1,1.8,'crop_gold',20)
    # Close orchard rows and a continuous windbreak instead of distant isolated trees.
    orchard=(372,483,80,219)
    for iz,z in enumerate(range(90,216,14)):
        for ix,x in enumerate(range(382,480,13)):
            ctx.tree(f'Meadow_Orchard_{ix}_{iz}',x,z,rng.uniform(7.3,9.8),'oak')
    ctx.path('Meadow_Orchard_Path',[(364,58),(364,242),(430,257)],3.2,'gravel')
    route_reservations=streets+[('Orchard',[(364,58),(364,242),(430,257)],3.2)]
    woodland_belts=[(-452,-47,57,185),(-293,-58,30,159),(-290,334,132,83),(-108,-525,146,81),
                    (115,-624,155,61),(570,138,80,223),(107,590,201,77)]
    def clear(x,z,h):
        if min(((x-cx)/rx)**2+((z-cz)/rz)**2 for cx,cz,rx,rz in woodland_belts)>1:return False
        if ctx.ground(x,z)<-1:return False
        if -248<x<286 and -434<z<435:return False
        if any(abs(x-p['center'][0])<p['half'][0]+11 and abs(z-p['center'][1])<p['half'][1]+5 for p in plots):return False
        if math.hypot(x+420,z-350)<34:return False
        if orchard[0]-10<x<orchard[1]+10 and orchard[2]-10<z<orchard[3]+10:return False
        if any(abs(x-fx)<w/2+9 and abs(z-fz)<d/2+9 for fx,fz,w,d in fields):return False
        if any(distance_segment(x,z,a,b)<w/2+5 for _,pts,w in route_reservations for a,b in zip(pts,pts[1:])):return False
        # Keep selected rolling pasture openings while enclosing their edges with woods.
        if ((x-260)/90)**2+((z+220)/145)**2<1:return False
        return True
    ctx.collection('MEADOW_CONTINUOUS_WOODLAND')
    trees=woodland(ctx,'Meadow_Woods',(-751,750,-753,750),clear,11.8,7201,('oak','oak','oak','pine'),(18,27))
    return {'fields':fields,'orchard':orchard,'woodland_trees':len(trees),'canopy_spacing':11.8,
            'woodland_belts':woodland_belts,'composition':'Continuous wooded field boundaries and village enclosure, with cultivated open countryside between them.'}


def harbor_town(ctx, bench, lamp, fence):
    rng=random.Random(98231)
    streets=[('Promenade',[(1801,-230),(1801,230)],6.5),
             ('MerchantLane',[(1743,-231),(1743,231)],6),
             ('GardenLane',[(1683,-231),(1683,231)],5.5),
             ('HarborAvenue',[(1510,0),(1830,0)],8)]
    for z in (-185,-92,92,185):streets.append((f'Cross{z}',[(1634,z),(1829,z)],5))
    ctx.collection('PORT_STREET_AND_PARCEL_SYSTEM')
    for name,pts,w in streets:
        ctx.path('Harbor_'+name+'/paving',pts,w+4.4,'stone',lift=.11)
        ctx.path('Harbor_'+name+'/road',pts,w,'harbor_paving',lift=.15)
        # Boundaries are generated once by the street, not by each building.
        a,b=pts[0],pts[-1];dx,dz=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dz)
        nx,nz=-dz/length,dx/length
        for side in (-1,1):
            q=[(x+side*nx*(w/2+.2),z+side*nz*(w/2+.2)) for x,z in pts]
            ctx.path('Harbor_'+name+f'/curb{side}',q,.28,'cream',lift=.24)
    buildings=[];reserved=[]
    columns=[(1669,1683),(1697,1683),(1729,1743),(1757,1743),(1787,1801)]
    rows=[-218,-202,-165,-147,-129,-111,-71,-52,-32,31,50,69,112,130,148,166,204,221]
    ctx.collection('PORT_COMPACT_MERCHANT_QUARTERS')
    for ci,(x,lane) in enumerate(columns):
        for ri,z in enumerate(rows):
            if ci in (1,2) and 25<z<80:continue
            width=rng.uniform(9.4,12.0);depth=rng.uniform(8.6,11.0)
            height=(6.4,9.55,9.35,6.2,12.25)[(ci+ri)%5]
            yaw=math.pi/2 if x<lane else -math.pi/2
            name=f'Harbor_Block{ci}_House{ri:02}'
            ctx.building(name,x,z,width,depth,height,
                         ('plaster_ivory','plaster_ochre','plaster_rose','stone')[(ci*3+ri)%4],
                         'roof_terracotta',yaw,('mediterranean','merchant','townhouse')[(ci+ri)%3])
            side=1 if x<lane else -1;edge,entry_z=entry_anchor(x,z,width,depth,yaw)
            ctx.path(name+'/entry',[(edge,entry_z),(lane-side*3,entry_z)],1.55,'stone',lift=.21)
            item={'id':name,'center':[x,z],'size':[width,depth],'height':height,'yaw':yaw,
                  'street':lane,'entry':[edge,entry_z],'enterable':False}
            buildings.append(item);reserved.append((x,z,depth/2+2,width/2+1.3))
            if ri%3==0:
                planting(ctx,name+'/door-flowers',edge,z+3,'rose',1.1,1.5,ci*30+ri)
            # Intimate back courts have paving, a planted border and independent access.
            if ci in (0,2) and ri%3==1:
                bx=x-side*(depth/2+3)
                ctx.path(name+'/court',[(bx,z-3),(bx,z+3)],4.3,'sandstone',lift=.13)
                planting(ctx,name+'/court-lavender',bx-side*1.7,z,'lavender',.8,5.2,600+ri)
    # Public square is a reserved void in a dense street, with a modest civic hall.
    ctx.path('Harbor_MarketSquare',[(1728,26),(1728,73)],23,'sandstone',lift=.15)
    ctx.building('Harbor_CivicHall',1706,48,15,12,12.4,'plaster_ivory','roof_terracotta',math.pi/2,'merchant')
    hall_entry=entry_anchor(1706,48,15,12,math.pi/2)
    ctx.path('Harbor_CivicHall/entry',[hall_entry,(1728,hall_entry[1])],1.8,'stone',lift=.21)
    reserved.append((1706,48,8,10))
    for i,(x,z) in enumerate(((1721,31),(1734,66),(1721,65))):
        bench(ctx,f'Harbor_Square_Bench{i}',x,z,yaw=math.pi/2)
    for i,z in enumerate((30,36,60,66,72)):
        x=1719;g=ctx.ground(x,z)
        ctx.box(f'Harbor_Market{i}/table',x,g+.85,z,2.1,.18,3,'timber')
        for sx in (-1,1):
            for sz in (-1,1):ctx.box(f'Harbor_Market{i}/post{sx}{sz}',x+sx*1.2,g+1.3,z+sz*1.65,.12,2.6,.12,'timber')
        ctx.mesh(f'Harbor_Market{i}/awning',[(x-1.4,g+2.7,z-1.9),(x+1.4,g+2.9,z-1.9),
                  (x+1.4,g+2.9,z+1.9),(x-1.4,g+2.7,z+1.9)],[(0,1,2,3)],'meadow_canvas' if i%2 else 'harbor_teal')
        for j in range(3):ctx.box(f'Harbor_Market{i}/crate{j}',x,g+1.1,z-1+j,.7,.45,.8,'timber')
    # A planted park behind the dense frontage balances the town without empty plots.
    park=(1550,1638,-215,228)
    ctx.path('Harbor_ParkWalk',[(1588,-232),(1597,-92),(1593,0),(1603,95),(1587,239)],3,'gravel')
    for i,z in enumerate(range(-210,231,19)):
        for side in (-1,1):
            x=1595+side*24+rng.uniform(-6,6)
            ctx.tree(f'Harbor_Park_Oak{i}_{side}',x,z,rng.uniform(12,18),'oak')
            planting(ctx,f'Harbor_Park_Border{i}_{side}',x,z,'mixed',4.8,3.2,300+i)
        if i%3==0:bench(ctx,f'Harbor_Park_Bench{i}',1597,z,yaw=math.pi/2)
    for i,z in enumerate(range(-220,225,20)):
        for x in (1688,1748,1806):
            if abs(z)<12 or any(abs(z-q)<10 for q in (-185,-92,92,185)):continue
            lamp(ctx,f'Harbor_Lantern{x}_{i}',x,z,height=4.2)
        if abs(z)>18:
            ctx.tree(f'Harbor_Promenade_Oak{i}',1814,z,11+(i%3),'oak')
            planting(ctx,f'Harbor_Promenade_Bed{i}',1814,z,'lavender',2,2,811+i)
    return streets,buildings,reserved,park


def harbor_landscape(ctx, streets):
    approaches=[('West',[(810,-60),(1120,-40),(1380,0),(1510,0)],7),
                ('North',[(1743,-231),(1660,-330),(1480,-490),(1200,-800)],6),
                ('South',[(1743,231),(1710,415),(1720,646),(1630,800)],6)]
    for name,pts,w in approaches:ctx.path('Harbor_Approach_'+name,pts,w,'gravel')
    woodland_belts=[(1433,14,116,315),(1675,-392,133,90),(1684,397,123,88),(1128,-18,126,171)]
    def allowed(x,z,h):
        if min(((x-cx)/rx)**2+((z-cz)/rz)**2 for cx,cz,rx,rz in woodland_belts)>1:return False
        if ctx.ground(x,z)<3:return False
        if x>1522 and -275<z<278:return False
        if any(distance_segment(x,z,a,b)<w/2+6 for _,pts,w in streets+approaches for a,b in zip(pts,pts[1:])):return False
        # Small rocky glades make the broad woods irregular without uniform emptiness.
        if ((x-1190)/100)**2+((z+310)/95)**2<1:return False
        if ((x-1280)/130)**2+((z-315)/100)**2<1:return False
        return True
    ctx.collection('PORT_DENSE_COASTAL_WOODS')
    trees=woodland(ctx,'Harbor_CoastalWoods',(843,1830,-743,744),allowed,12.3,444,
                   ('oak','oak','oak','cypress','pine'),(17,25))
    return {'woodland_trees':len(trees),'canopy_spacing':12.3,'approaches':approaches,
            'woodland_belts':woodland_belts,'composition':'Dense woodland encloses the city and frames its approaches; open coastal meadow separates distinct groves.'}

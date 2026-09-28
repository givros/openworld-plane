"""Shared architecture/frontage datums, usable without importing Blender."""
import math


def facade_bays(length):
    count=max(1,round((length-.9)/2.6))
    step=(length-.9)/count
    positions=[-length/2+.45+(i+.5)*step for i in range(count)]
    door_bay=min(range(count),key=lambda i:abs(positions[i]))
    return positions,step,door_bay


def entry_anchor(x,z,width,depth,yaw=0,offset=.6):
    positions,_,door_bay=facade_bays(width)
    u,v=positions[door_bay],depth/2+offset
    return [x+u*math.cos(yaw)+v*math.sin(yaw),z-u*math.sin(yaw)+v*math.cos(yaw)]

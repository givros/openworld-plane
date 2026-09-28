// Isolated r184 research prototype. Not imported by the game.
import MeshStandardNodeMaterial from 'three/src/materials/nodes/MeshStandardNodeMaterial.js';
import { context, mat3, vec3, vec4 } from 'three/src/nodes/TSL.js';
import Node from 'three/src/nodes/core/Node.js';
import { positionGeometry, positionView, positionViewDirection } from 'three/src/nodes/accessors/Position.js';
import { diffuseColor, diffuseContribution, metalness, roughness } from 'three/src/nodes/core/PropertyNode.js';

/** Same cotangent-frame arithmetic as Three's normalmap_pars_fragment, with
 * caller-provided derivatives extrapolated on this hit's original triangle.
 * `normal` already includes the source front/back-face sign; frameSign is that
 * same sign for smooth DoubleSide material, and 1 for flat shading.
 */
export function normalFromHitGradients({normal, positionDx, positionDy, uvDx, uvDy, sampledNormal, normalScale, frameSign}) {
  const q1perp = positionDy.cross(normal);
  const q0perp = normal.cross(positionDx);
  const tangent = q1perp.mul(uvDx.x).add(q0perp.mul(uvDy.x));
  const bitangent = q1perp.mul(uvDx.y).add(q0perp.mul(uvDy.y));
  const determinant = tangent.dot(tangent).max(bitangent.dot(bitangent));
  const scale = determinant.equal(0).select(0, determinant.inverseSqrt());
  const frame = mat3(tangent.mul(scale).mul(frameSign), bitangent.mul(scale).mul(frameSign), normal);
  const mapped = sampledNormal.xyz.mul(2).sub(1);
  return frame.mul(vec3(mapped.xy.mul(normalScale), mapped.z)).normalize();
}

class HitPositionSetupNode extends Node {
  constructor(hit) {
    super('void');
    this.viewAccessor = positionView;
    this.directionAccessor = positionViewDirection;
    this.hitView = hit.positionView;
    this.hitDirection = hit.positionView.negate().normalize();
  }

  generate(builder) {
    // Assignment to a public Fn accessor creates a VarIntent copy in r184.
    // Build each accessor as an r-value, then assign its actual generated variable.
    // This tiny backend-independent statement adapter avoids forking the PBR code.
    const view = this.viewAccessor.build(builder, 'vec3');
    const direction = this.directionAccessor.build(builder, 'vec3');
    builder.addLineFlowCode(`${view} = ${this.hitView.build(builder, 'vec3')}`, this);
    builder.addLineFlowCode(`${direction} = ${this.hitDirection.build(builder, 'vec3')}`, this);
    return '';
  }
}

/**
 * A hit-buffer adapter around Three's stock PhysicalLightingModel.
 * All inputs are fragment nodes reconstructed from an original triangle hit.
 * The caller supplies resolved normal-map normal and same-triangle roughness
 * derivatives; fullscreen dFdx/dFdy are not valid at visibility discontinuities.
 * This proves node composition only, not pixel equivalence or GPU performance.
 */
export class DeferredStandardMaterial extends MeshStandardNodeMaterial {
  constructor(hit, parameters = {}) {
    super(parameters);
    this.hit = hit;
    this.vertexNode = vec4(positionGeometry.xy, 0, 1);
    this.colorNode = hit.color;
    this.normalNode = hit.normalView;
    this.emissiveNode = hit.emissive ?? vec3(0);
    this.receivedShadowPositionNode = hit.positionWorld;
    this.depthNode = hit.depth;
    this.fog = false; // Current game fog is applied after output conversion.
    this.contextNode = context({ getUV: () => hit.uv });
  }

  setupDiffuseColor(builder) {
    // r184's custom vertexNode makes positionView a writable fragment variable.
    // positionViewDirection otherwise describes the fullscreen triangle.
    new HitPositionSetupNode(this.hit).toStack();
    super.setupDiffuseColor(builder);
  }

  setupVariants() {
    // Same operations as MeshStandardNodeMaterial, with analytically reconstructed
    // source-triangle normal derivatives instead of derivatives of the hit image.
    metalness.assign(this.hit.metalness);
    roughness.assign(this.hit.roughness.max(0.0525).add(this.hit.geometryRoughness).min(1));
    this.setupSpecular();
    diffuseContribution.assign(diffuseColor.rgb.mul(metalness.oneMinus()));
  }
}

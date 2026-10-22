import { Suspense, useEffect, useMemo } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  RoundedBox,
} from '@react-three/drei'
import {
  Color,
  DataTexture,
  ExtrudeGeometry,
  LinearFilter,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  Shape,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { ProductOption } from '@lovbase/core/product-3d'

function grainTexture(fabric: boolean) {
  const size = 128
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const noise = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
      const random = noise - Math.floor(noise)
      const grain = Math.sin(x * 0.52 + Math.sin(y * 0.035) * 2.1 + Math.sin(x * 0.1) * 1.2)
      const value = fabric ? 180 + random * 55 + ((x + y) % 2) * 20 : 220 + grain * 15 + random * 10
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = value
      data[i + 3] = 255
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = texture.minFilter = LinearFilter
  texture.repeat.set(fabric ? 6 : 1, fabric ? 6 : 2)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}
function curvedBack(width: number, height: number, depth: number) {
  const r = 0.055
  const x = -width / 2
  const y = -height / 2
  const shape = new Shape()
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + r)
  shape.lineTo(x + width, y + height - r)
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  shape.lineTo(x + r, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 5,
    steps: 8,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    curveSegments: 24,
  })
  const positions = geometry.attributes.position
  for (let i = 0; i < positions.count; i++) {
    const px = positions.getX(i)
    positions.setZ(i, positions.getZ(i) - depth / 2 + px * px * 1.1)
  }
  geometry.computeVertexNormals()
  return geometry
}
function Timber({
  from,
  to,
  color,
  roughness,
  texture,
  radius = 0.023,
}: {
  from: [number, number, number]
  to: [number, number, number]
  color: string
  roughness: number
  texture: DataTexture
  radius?: number
}) {
  const a = new Vector3(...from)
  const b = new Vector3(...to)
  const direction = b.clone().sub(a)
  const quaternion = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    direction.clone().normalize(),
  )
  return (
    <mesh castShadow receiveShadow position={a.add(b).multiplyScalar(0.5)} quaternion={quaternion}>
      <cylinderGeometry args={[radius, radius * 0.78, direction.length(), 32]} />
      <meshStandardMaterial color={color} roughness={roughness} map={texture} />
    </mesh>
  )
}
function Chair({ seat, frame }: { seat?: ProductOption; frame?: ProductOption }) {
  const wood = useMemo(() => grainTexture(false), [])
  const fabric = useMemo(() => grainTexture(true), [])
  const cushion = useMemo(() => curvedBack(0.47, 0.235, 0.065), [])
  const backing = useMemo(() => curvedBack(0.49, 0.245, 0.028), [])
  useEffect(
    () => () => {
      wood.dispose()
      fabric.dispose()
      cushion.dispose()
      backing.dispose()
    },
    [wood, fabric, cushion, backing],
  )
  const color = frame?.color ?? '#b88b58'
  const roughness = frame?.roughness ?? 0.5
  const timber = { color, roughness, texture: wood }
  return (
    <group>
      {[-1, 1].map((side) => (
        <group key={side}>
          <Timber
            {...timber}
            from={[side * 0.225, 0.018, 0.215]}
            to={[side * 0.185, 0.43, 0.165]}
            radius={0.026}
          />
          <Timber
            {...timber}
            from={[side * 0.225, 0.018, -0.22]}
            to={[side * 0.19, 0.74, -0.205]}
            radius={0.025}
          />
          <Timber
            {...timber}
            from={[side * 0.19, 0.397, -0.18]}
            to={[side * 0.19, 0.397, 0.18]}
            radius={0.024}
          />
        </group>
      ))}
      {[-0.17, 0.17].map((z) => (
        <Timber key={z} {...timber} from={[-0.2, 0.396, z]} to={[0.2, 0.396, z]} radius={0.025} />
      ))}
      <RoundedBox
        args={[0.495, 0.085, 0.46]}
        radius={0.038}
        smoothness={6}
        position={[0, 0.458, 0.018]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color={seat?.color ?? '#d8cdb8'}
          roughness={seat?.roughness ?? 0.92}
          map={fabric}
          bumpMap={fabric}
          bumpScale={0.0012}
        />
      </RoundedBox>
      <mesh
        geometry={backing}
        position={[0, 0.728, -0.237]}
        rotation={[-0.1, 0, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={color} roughness={roughness} map={wood} />
      </mesh>
      <mesh
        geometry={cushion}
        position={[0, 0.728, -0.195]}
        rotation={[-0.1, 0, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color={seat?.color ?? '#d8cdb8'}
          roughness={seat?.roughness ?? 0.92}
          map={fabric}
          bumpMap={fabric}
          bumpScale={0.0012}
        />
      </mesh>
    </group>
  )
}
function ContextLoss({ onFailure }: { onFailure: () => void }) {
  const { gl } = useThree()
  useEffect(() => {
    const canvas = gl.domElement
    canvas.addEventListener('webglcontextlost', onFailure)
    return () => canvas.removeEventListener('webglcontextlost', onFailure)
  }, [gl, onFailure])
  return null
}
export default function ChairScene({
  seat,
  frame,
  resetKey,
  onFailure,
}: {
  seat?: ProductOption
  frame?: ProductOption
  resetKey: number
  onFailure: () => void
}) {
  return (
    <Canvas
      key={resetKey}
      shadows
      dpr={[1, 1.5]}
      frameloop="demand"
      camera={{ position: [1.2, 1.02, 1.55], fov: 34 }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ scene }) => {
        scene.background = new Color('#f0ede6')
      }}
    >
      <ContextLoss onFailure={onFailure} />
      <ambientLight intensity={0.65} />
      <directionalLight
        castShadow
        position={[3, 5, 4]}
        intensity={2.2}
        shadow-mapSize={[1024, 1024]}
        shadow-normalBias={0.025}
      />
      <Suspense fallback={null}>
        <Environment resolution={128} frames={1}>
          <Lightformer form="rect" intensity={3} position={[2, 3, 2]} scale={[4, 5, 1]} />
          <Lightformer
            form="rect"
            intensity={2}
            position={[-3, 1, -1]}
            rotation={[0, Math.PI / 2, 0]}
            scale={[3, 4, 1]}
          />
        </Environment>
        <Chair seat={seat} frame={frame} />
        <ContactShadows
          position={[0, -0.008, 0]}
          opacity={0.35}
          scale={4}
          blur={2.5}
          far={1}
          resolution={256}
          frames={1}
        />
      </Suspense>
      <OrbitControls
        makeDefault
        target={[0, 0.44, 0]}
        enablePan={false}
        minDistance={1.05}
        maxDistance={3.2}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 2.05}
      />
    </Canvas>
  )
}

import { useAppStore } from '@/stores/appStore'
import './scenes.css'

const sceneAccent: Record<string, string> = {
  leave: 'linear-gradient(145deg, #3d4a5c, #1c222b)',
  home: 'linear-gradient(145deg, #ff9a4d, #ff6a00)',
  sleep: 'linear-gradient(145deg, #4b5d8a, #2a3550)',
  movie: 'linear-gradient(145deg, #6b4f8a, #3a2a4f)',
  read: 'linear-gradient(145deg, #d4a25a, #b87a2f)',
}

export function ScenesPage() {
  const scenes = useAppStore((s) => s.scenes)
  const dataSource = useAppStore((s) => s.dataSource)
  const runScene = useAppStore((s) => s.runScene)

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>场景</h1>
          <p>{dataSource === 'live' ? '执行云端手动场景' : '演示场景'}</p>
        </div>
      </header>

      <div className="room-tabs">
        <button type="button" className="room-tab active">
          {dataSource === 'live' ? '我的场景' : '推荐'}
        </button>
      </div>

      <div className="scene-grid">
        {scenes.length === 0 ? (
          <p className="empty">暂无场景</p>
        ) : (
          scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              className="scene-card"
              onClick={() => void runScene(scene)}
            >
              <div
                className="scene-art"
                style={{ background: sceneAccent[scene.icon] || sceneAccent.home }}
              />
              <div className="scene-body">
                <h3>{scene.name || scene.nameKey}</h3>
                <p>
                  {scene.descKey
                    ? scene.descKey
                    : dataSource === 'live'
                      ? '云端手动场景'
                      : ''}
                </p>
                <span>执行</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

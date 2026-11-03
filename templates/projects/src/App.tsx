import { ProjectsApp } from './ProjectsApp'
import { projectsClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="projects-viewport">
      <ProjectsApp client={projectsClient} initialLocale={defaultLocale} />
    </div>
  )
}

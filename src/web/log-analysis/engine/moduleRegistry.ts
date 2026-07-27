import type { AnalysisModule } from './AnalysisModule.js'

export class ModuleRegistry {
  private modules = new Map<string, AnalysisModule>()

  register(module: AnalysisModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module ${module.id} already registered`)
    }
    this.modules.set(module.id, module)
  }

  get(id: string): AnalysisModule | undefined {
    return this.modules.get(id)
  }

  getAll(): AnalysisModule[] {
    return [...this.modules.values()]
  }

  getBySection(section: string): AnalysisModule[] {
    return this.getAll().filter(m => m.section === section)
  }
}

import { ProductStudio } from './ProductStudio'
import { product3dClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return <ProductStudio client={product3dClient} locale={defaultLocale} />
}

import "./styles/fonts.css"
import { bootWindow } from "@/services/boot"

void bootWindow("layer-editor", () => import("./components/layer-editor/LayerEditor.vue"))

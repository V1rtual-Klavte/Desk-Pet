import "./styles/fonts.css"
import { bootWindow } from "@/services/boot"

void bootWindow("layer-editor", () => import("./components/LayerEditor.vue"))

const ws = new WebSocket(`wss://${location.host}`)

const canvas = document.getElementById("cam")
const ctx = canvas.getContext("2d")

ws.binaryType = "arraybuffer"

ws.onmessage = e => {

    const blob = new Blob([e.data], {type:"image/jpeg"})
    const img = new Image()

    img.onload = ()=>{
        ctx.drawImage(img,0,0,canvas.width,canvas.height)
        URL.revokeObjectURL(img.src)
    }

    img.src = URL.createObjectURL(blob)

}
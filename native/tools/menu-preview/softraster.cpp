#include "softraster.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

SoftRaster::SoftRaster(int Width, int Height) : W(Width), H(Height), Px(size_t(Width) * Height * 3, 0.f) {}

void SoftRaster::Clear(ImU32 Color)
{
    const float R = ((Color >> IM_COL32_R_SHIFT) & 0xFF) / 255.f;
    const float G = ((Color >> IM_COL32_G_SHIFT) & 0xFF) / 255.f;
    const float B = ((Color >> IM_COL32_B_SHIFT) & 0xFF) / 255.f;
    for (size_t i = 0; i < Px.size(); i += 3) { Px[i] = R; Px[i + 1] = G; Px[i + 2] = B; }
}

void SoftRaster::Blit(const std::vector<uint8_t>& Rgba, int Width, int Height)
{
    for (int y = 0; y < std::min(H, Height); ++y)
        for (int x = 0; x < std::min(W, Width); ++x)
        {
            const uint8_t* S = &Rgba[(size_t(y) * Width + x) * 4];
            float* D = &Px[(size_t(y) * W + x) * 3];
            D[0] = S[0] / 255.f; D[1] = S[1] / 255.f; D[2] = S[2] / 255.f;
        }
}

ImTextureID SoftRaster::AddTexture(SoftTexture Texture)
{
    const intptr_t Id = NextId++;
    Textures[Id] = std::move(Texture);
    return (ImTextureID)Id;
}

void SoftRaster::UpdateTextures(ImDrawData* DrawData)
{
    if (!DrawData->Textures)
        return;
    for (ImTextureData* Tex : *DrawData->Textures)
    {
        if (Tex->Status == ImTextureStatus_OK)
            continue;
        if (Tex->Status == ImTextureStatus_WantDestroy)
        {
            Textures.erase((intptr_t)Tex->GetTexID());
            Tex->SetTexID(ImTextureID_Invalid);
            Tex->SetStatus(ImTextureStatus_Destroyed);
            continue;
        }
        // Anlegen oder Aktualisieren: einfach komplett neu kopieren
        SoftTexture Copy;
        Copy.Width = Tex->Width;
        Copy.Height = Tex->Height;
        Copy.Rgba.resize(size_t(Tex->Width) * Tex->Height * 4);
        const unsigned char* Src = (const unsigned char*)Tex->GetPixels();
        for (int i = 0; i < Tex->Width * Tex->Height; ++i)
        {
            if (Tex->Format == ImTextureFormat_Alpha8)
            {
                Copy.Rgba[i * 4 + 0] = 255; Copy.Rgba[i * 4 + 1] = 255; Copy.Rgba[i * 4 + 2] = 255;
                Copy.Rgba[i * 4 + 3] = Src[i];
            }
            else
            {
                for (int c = 0; c < 4; ++c) Copy.Rgba[i * 4 + c] = Src[i * 4 + c];
            }
        }
        intptr_t Id = (intptr_t)Tex->GetTexID();
        if (Tex->Status == ImTextureStatus_WantCreate || Id == 0)
            Id = NextId++;
        Textures[Id] = std::move(Copy);
        Tex->SetTexID((ImTextureID)Id);
        Tex->SetStatus(ImTextureStatus_OK);
    }
}

static inline float EdgeFn(float ax, float ay, float bx, float by, float px, float py)
{
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

static inline void Unpack(ImU32 C, float Out[4])
{
    Out[0] = ((C >> IM_COL32_R_SHIFT) & 0xFF) / 255.f;
    Out[1] = ((C >> IM_COL32_G_SHIFT) & 0xFF) / 255.f;
    Out[2] = ((C >> IM_COL32_B_SHIFT) & 0xFF) / 255.f;
    Out[3] = ((C >> IM_COL32_A_SHIFT) & 0xFF) / 255.f;
}

static inline void Sample(const SoftTexture* T, float U, float V, float Out[4])
{
    if (!T || T->Width == 0) { Out[0] = Out[1] = Out[2] = Out[3] = 1.f; return; }
    // bilinear
    const float X = U * T->Width - 0.5f, Y = V * T->Height - 0.5f;
    const int X0 = (int)std::floor(X), Y0 = (int)std::floor(Y);
    const float FX = X - X0, FY = Y - Y0;
    float Acc[4] = { 0, 0, 0, 0 };
    for (int dy = 0; dy < 2; ++dy)
        for (int dx = 0; dx < 2; ++dx)
        {
            const int SX = std::clamp(X0 + dx, 0, T->Width - 1), SY = std::clamp(Y0 + dy, 0, T->Height - 1);
            const float Wt = (dx ? FX : 1 - FX) * (dy ? FY : 1 - FY);
            const uint8_t* P = &T->Rgba[(size_t(SY) * T->Width + SX) * 4];
            for (int c = 0; c < 4; ++c) Acc[c] += P[c] / 255.f * Wt;
        }
    for (int c = 0; c < 4; ++c) Out[c] = Acc[c];
}

void SoftRaster::DrawTriangle(const ImDrawVert& A, const ImDrawVert& B, const ImDrawVert& C,
    const SoftTexture* Tex, const ImVec4& Clip)
{
    const float Area = EdgeFn(A.pos.x, A.pos.y, B.pos.x, B.pos.y, C.pos.x, C.pos.y);
    if (std::fabs(Area) < 1e-8f)
        return;
    int MinX = (int)std::floor(std::min({ A.pos.x, B.pos.x, C.pos.x }));
    int MaxX = (int)std::ceil(std::max({ A.pos.x, B.pos.x, C.pos.x }));
    int MinY = (int)std::floor(std::min({ A.pos.y, B.pos.y, C.pos.y }));
    int MaxY = (int)std::ceil(std::max({ A.pos.y, B.pos.y, C.pos.y }));
    MinX = std::max({ MinX, (int)std::floor(Clip.x), 0 });
    MinY = std::max({ MinY, (int)std::floor(Clip.y), 0 });
    MaxX = std::min({ MaxX, (int)std::ceil(Clip.z), W });
    MaxY = std::min({ MaxY, (int)std::ceil(Clip.w), H });
    float CA[4], CB[4], CC[4];
    Unpack(A.col, CA); Unpack(B.col, CB); Unpack(C.col, CC);
    for (int y = MinY; y < MaxY; ++y)
        for (int x = MinX; x < MaxX; ++x)
        {
            const float PX = x + 0.5f, PY = y + 0.5f;
            if (PX < Clip.x || PX >= Clip.z || PY < Clip.y || PY >= Clip.w)
                continue;
            float W0 = EdgeFn(B.pos.x, B.pos.y, C.pos.x, C.pos.y, PX, PY) / Area;
            float W1 = EdgeFn(C.pos.x, C.pos.y, A.pos.x, A.pos.y, PX, PY) / Area;
            float W2 = 1.f - W0 - W1;
            if (W0 < -1e-5f || W1 < -1e-5f || W2 < -1e-5f)
                continue;
            const float U = W0 * A.uv.x + W1 * B.uv.x + W2 * C.uv.x;
            const float V = W0 * A.uv.y + W1 * B.uv.y + W2 * C.uv.y;
            float T[4];
            Sample(Tex, U, V, T);
            float Col[4];
            for (int c = 0; c < 4; ++c) Col[c] = (W0 * CA[c] + W1 * CB[c] + W2 * CC[c]) * T[c];
            float* D = &Px[(size_t(y) * W + x) * 3];
            const float Alpha = std::clamp(Col[3], 0.f, 1.f);
            for (int c = 0; c < 3; ++c) D[c] = Col[c] * Alpha + D[c] * (1.f - Alpha);
        }
}

void SoftRaster::Render(ImDrawData* DrawData)
{
    UpdateTextures(DrawData);
    for (int n = 0; n < DrawData->CmdListsCount; ++n)
    {
        const ImDrawList* List = DrawData->CmdLists[n];
        for (const ImDrawCmd& Cmd : List->CmdBuffer)
        {
            if (Cmd.UserCallback)
                continue;
            const ImVec4 Clip(Cmd.ClipRect.x - DrawData->DisplayPos.x, Cmd.ClipRect.y - DrawData->DisplayPos.y,
                Cmd.ClipRect.z - DrawData->DisplayPos.x, Cmd.ClipRect.w - DrawData->DisplayPos.y);
            auto It = Textures.find((intptr_t)Cmd.GetTexID());
            const SoftTexture* Tex = It == Textures.end() ? nullptr : &It->second;
            for (unsigned int i = 0; i < Cmd.ElemCount; i += 3)
            {
                const ImDrawVert& A = List->VtxBuffer[Cmd.VtxOffset + List->IdxBuffer[Cmd.IdxOffset + i]];
                const ImDrawVert& B = List->VtxBuffer[Cmd.VtxOffset + List->IdxBuffer[Cmd.IdxOffset + i + 1]];
                const ImDrawVert& C = List->VtxBuffer[Cmd.VtxOffset + List->IdxBuffer[Cmd.IdxOffset + i + 2]];
                DrawTriangle(A, B, C, Tex, Clip);
            }
        }
    }
}

bool SoftRaster::SavePpm(const std::string& Path) const
{
    FILE* F = std::fopen(Path.c_str(), "wb");
    if (!F)
        return false;
    std::fprintf(F, "P6\n%d %d\n255\n", W, H);
    for (float V : Px)
    {
        const int B = (int)std::lround(std::clamp(V, 0.f, 1.f) * 255.f);
        std::fputc(B, F);
    }
    std::fclose(F);
    return true;
}

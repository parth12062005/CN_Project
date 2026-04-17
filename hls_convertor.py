import os
import subprocess
import sys
import re
import hashlib
import json

def get_video_codec(input_file):
    """Detect the video codec of the input file."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", input_file],
            capture_output=True, text=True, check=True
        )
        return result.stdout.strip()
    except Exception:
        return None

def get_video_duration(input_file):
    """Get video duration in seconds."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", input_file],
            capture_output=True, text=True, check=True
        )
        return float(result.stdout.strip())
    except Exception:
        return 10.0  # fallback

def sanitize_name(filename):
    """Derive a clean folder name from a filename."""
    name = os.path.splitext(os.path.basename(filename))[0]
    name = re.sub(r'[^\w\s-]', '', name)       # remove special chars
    name = re.sub(r'\s+', '_', name.strip())    # spaces → underscores
    return name

def generate_thumbnail(input_file, output_dir):
    """Generate a thumbnail from ~25% into the video."""
    thumbnail_path = os.path.join(output_dir, "thumbnail.jpg")
    duration = get_video_duration(input_file)
    timestamp = duration * 0.25

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(timestamp),
        "-i", input_file,
        "-vframes", "1",
        "-q:v", "2",
        "-vf", "scale=640:-1",
        thumbnail_path
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"   Thumbnail: {thumbnail_path}")
    except subprocess.CalledProcessError:
        print("   ⚠ Thumbnail generation failed (non-fatal)")

def generate_hashes(output_dir):
    """Compute SHA-256 hash of every .ts chunk and write hashes.json."""
    hashes = {}
    chunks = sorted(f for f in os.listdir(output_dir) if f.endswith('.ts'))
    for chunk_name in chunks:
        chunk_path = os.path.join(output_dir, chunk_name)
        sha = hashlib.sha256()
        with open(chunk_path, 'rb') as f:
            while True:
                block = f.read(65536)  # 64 KB read blocks
                if not block:
                    break
                sha.update(block)
        hashes[chunk_name] = sha.hexdigest()

    hash_file = os.path.join(output_dir, 'hashes.json')
    with open(hash_file, 'w', encoding='utf-8') as f:
        json.dump(hashes, f, indent=2)

    print(f"   Hashes:    {len(hashes)} chunk SHA-256 signatures → hashes.json")

def convert_to_hls(input_file, output_base="output", chunk_duration=4):
    if not os.path.exists(input_file):
        print("❌ Input file not found:", input_file)
        return

    # Per-video folder
    video_name = sanitize_name(input_file)
    output_dir = os.path.join(output_base, video_name)
    os.makedirs(output_dir, exist_ok=True)

    output_path = os.path.join(output_dir, "index.m3u8")
    segment_pattern = os.path.join(output_dir, "seg%03d.ts")

    # Detect codec
    codec = get_video_codec(input_file)
    print(f"\n🎬 Converting: {input_file}")
    print(f"   Video name: {video_name}")
    print(f"   Detected codec: {codec or 'unknown'}")

    if codec == "h264":
        print("   Mode: stream copy (fast)")
        video_args = ["-c:v", "copy"]
        audio_args = ["-c:a", "aac"]
    else:
        print("   Mode: transcoding to H.264 + AAC")
        video_args = ["-c:v", "libx264", "-preset", "fast", "-crf", "23"]
        audio_args = ["-c:a", "aac", "-b:a", "128k"]

    command = [
        "ffmpeg", "-y",
        "-i", input_file,
        *video_args,
        *audio_args,
        "-start_number", "0",
        "-hls_time", str(chunk_duration),
        "-hls_list_size", "0",
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", segment_pattern,
        "-f", "hls",
        output_path
    ]

    print(f"   Chunk duration: {chunk_duration}s")
    print(f"   Output dir: {output_dir}/\n")

    try:
        subprocess.run(command, check=True)
        chunks = [f for f in os.listdir(output_dir) if f.endswith('.ts')]
        print(f"\n✅ HLS conversion done! {len(chunks)} chunks")

        # Generate thumbnail
        print("   Generating thumbnail...")
        generate_thumbnail(input_file, output_dir)

        # Generate SHA-256 integrity hashes
        print("   Computing SHA-256 chunk hashes...")
        generate_hashes(output_dir)

        print(f"\n📂 Output: {output_dir}/")
        print(f"   Playlist:  index.m3u8")
        print(f"   Chunks:    {len(chunks)} segments")
        print(f"   Thumbnail: thumbnail.jpg")
        print(f"   Integrity: hashes.json")
        print(f"\n▶ Start server: node server.js")
    except FileNotFoundError:
        print("❌ ffmpeg not found. Install: sudo apt install ffmpeg")
    except subprocess.CalledProcessError as e:
        print(f"❌ Conversion failed (exit code {e.returncode})")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 hls_convertor.py <video_file> [chunk_duration]")
        print("  e.g: python3 hls_convertor.py video.mp4 4")
        print("\nOutput: output/<video_name>/")
    else:
        input_video = sys.argv[1]
        duration = int(sys.argv[2]) if len(sys.argv) > 2 else 4
        convert_to_hls(input_video, chunk_duration=duration)